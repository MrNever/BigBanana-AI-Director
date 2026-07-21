/**
 * 图片模型适配器
 * 处理 Gemini Image API
 */

import { ImageModelDefinition, ImageGenerateOptions, AspectRatio } from '../../types/model';
import { getApiKeyForModel, getApiBaseUrlForModel, getActiveImageModel } from '../modelRegistry';
import {
  getImageApiFormat,
  getDefaultImageEndpoint,
  resolveOpenAiImageEndpoint,
  mapAspectRatioToOpenAiImageSize,
} from '../imageModelUtils';
import { ApiKeyError } from './chatAdapter';

/**
 * 重试操作
 */
const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 2000
): Promise<T> => {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      const status = error?.status;
      // 400/401/403 错误不重试
      if (status === 400 ||
          status === 401 ||
          status === 403 ||
          error.message?.includes('400') ||
          error.message?.includes('401') ||
          error.message?.includes('403')) {
        throw error;
      }
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }

  throw lastError;
};

const parseHttpErrorBody = async (res: Response): Promise<string> => {
  let errorMessage = `HTTP 错误: ${res.status}`;
  try {
    const errorData = await res.json();
    errorMessage = errorData.error?.message || errorMessage;
  } catch (e) {
    const errorText = await res.text();
    if (errorText) errorMessage = errorText;
  }
  return errorMessage;
};

const buildImageApiError = (status: number, backendMessage?: string): Error => {
  const detail = backendMessage?.trim();
  const withDetail = (message: string): string => (detail ? `${message}（接口信息：${detail}）` : message);

  let message: string;
  if (status === 400) {
    message = withDetail('图片生成失败：提示词可能被风控拦截，请修改提示词后重试。');
  } else if (status === 500 || status === 503) {
    message = withDetail('图片生成失败：服务器繁忙，请稍后重试。');
  } else if (status === 429) {
    message = withDetail('图片生成失败：请求过于频繁，请稍后再试。');
  } else {
    message = withDetail(`图片生成失败：接口请求异常（HTTP ${status}）。`);
  }

  const err: any = new Error(message);
  err.status = status;
  return err;
};

const MAX_IMAGE_PROMPT_CHARS = 5000;
const OPENAI_IMAGE_QUALITY = 'medium';
const OPENAI_IMAGE_OUTPUT_FORMAT = 'png';
const OPENAI_IMAGE_OUTPUT_COMPRESSION = 100;

const truncatePromptToMaxChars = (
  input: string,
  maxChars: number
): { text: string; wasTruncated: boolean; originalLength: number } => {
  const chars = Array.from(input);
  const originalLength = chars.length;
  if (originalLength <= maxChars) {
    return { text: input, wasTruncated: false, originalLength };
  }
  return {
    text: chars.slice(0, maxChars).join(''),
    wasTruncated: true,
    originalLength,
  };
};

const dataUrlToImageFile = (dataUrl: string, filename: string): File | null => {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  try {
    const mimeType = match[1];
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], filename, { type: mimeType });
  } catch {
    return null;
  }
};

const extractImageFromOpenAiResponse = (response: any): string | null => {
  const first = response?.data?.[0];
  if (!first) return null;
  if (first.b64_json) {
    const format = first.output_format || OPENAI_IMAGE_OUTPUT_FORMAT;
    return `data:image/${format};base64,${first.b64_json}`;
  }
  if (first.url) {
    return String(first.url);
  }
  return null;
};

/**
 * 调用图片生成 API
 */
export const callImageApi = async (
  options: ImageGenerateOptions,
  model?: ImageModelDefinition
): Promise<string> => {
  // 获取当前激活的模型
  const activeModel = model || getActiveImageModel();
  if (!activeModel) {
    throw new Error('没有可用的图片模型');
  }

  // 获取 API 配置
  const apiKey = getApiKeyForModel(activeModel.id);
  if (!apiKey) {
    throw new ApiKeyError('API Key 缺失，请在设置中配置 API Key');
  }

  const apiBase = getApiBaseUrlForModel(activeModel.id);
  const apiModel = activeModel.apiModel || activeModel.id;
  const apiFormat = getImageApiFormat(activeModel);
  const endpointTemplate = activeModel.endpoint || getDefaultImageEndpoint(apiFormat, apiModel);
  const endpoint = endpointTemplate.replace('{model}', apiModel);

  // 确定宽高比
  const aspectRatio = options.aspectRatio || activeModel.params.defaultAspectRatio;

  // 构建提示词
  let finalPrompt = options.prompt;

  // 如果有参考图，添加一致性指令
  if (options.referenceImages && options.referenceImages.length > 0) {
    finalPrompt = `
      ⚠️⚠️⚠️ CRITICAL REQUIREMENTS - CHARACTER CONSISTENCY ⚠️⚠️⚠️

      Reference Images Information:
      - The FIRST image is the Scene/Environment reference.
      - Any subsequent images are Character references (Base Look or Variation).

      Task:
      Generate a cinematic shot matching this prompt: "${options.prompt}".

      ⚠️ ABSOLUTE REQUIREMENTS (NON-NEGOTIABLE):
      1. Scene Consistency:
         - STRICTLY maintain the visual style, lighting, and environment from the scene reference.

      2. Character Consistency - HIGHEST PRIORITY:
         If characters are present in the prompt, they MUST be IDENTICAL to the character reference images:
         • Facial Features: Eyes (color, shape, size), nose structure, mouth shape, facial contours must be EXACTLY the same
         • Hairstyle & Hair Color: Length, color, texture, and style must be PERFECTLY matched
         • Clothing & Outfit: Style, color, material, and accessories must be IDENTICAL
         • Body Type: Height, build, proportions must remain consistent

      ⚠️ DO NOT create variations or interpretations of the character - STRICT REPLICATION ONLY!
      ⚠️ Character appearance consistency is THE MOST IMPORTANT requirement!
    `;
  }

  const promptLimitResult = truncatePromptToMaxChars(finalPrompt, MAX_IMAGE_PROMPT_CHARS);
  if (promptLimitResult.wasTruncated) {
    console.warn(
      `[ImagePrompt] Prompt exceeded ${MAX_IMAGE_PROMPT_CHARS} chars ` +
      `(${promptLimitResult.originalLength}). Truncated before image request.`
    );
  }
  finalPrompt = promptLimitResult.text;

  if (apiFormat === 'openai') {
    const hasReferenceImages = Boolean(options.referenceImages?.length);
    const resolvedEndpoint = resolveOpenAiImageEndpoint(endpoint, hasReferenceImages);
    const openAiSize = mapAspectRatioToOpenAiImageSize(aspectRatio);

    const response = await retryOperation(async () => {
      let res: Response;
      if (hasReferenceImages) {
        const files = (options.referenceImages || [])
          .map((img, index) => dataUrlToImageFile(img, `reference-${index + 1}.png`))
          .filter((file): file is File => Boolean(file));

        if (files.length === 0) {
          throw new Error('图片生成失败：参考图格式无效，请上传图片后重试。');
        }

        const formData = new FormData();
        formData.append('model', apiModel);
        formData.append('prompt', finalPrompt);
        formData.append('size', openAiSize);
        formData.append('quality', OPENAI_IMAGE_QUALITY);
        formData.append('output_format', OPENAI_IMAGE_OUTPUT_FORMAT);
        formData.append('output_compression', String(OPENAI_IMAGE_OUTPUT_COMPRESSION));
        formData.append('n', '1');
        files.forEach(file => formData.append('image[]', file));

        res = await fetch(`${apiBase}${resolvedEndpoint}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': '*/*',
          },
          body: formData,
        });
      } else {
        const requestBody = {
          model: apiModel,
          prompt: finalPrompt,
          size: openAiSize,
          quality: OPENAI_IMAGE_QUALITY,
          output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
          output_compression: OPENAI_IMAGE_OUTPUT_COMPRESSION,
          n: 1,
        };

        res = await fetch(`${apiBase}${resolvedEndpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Accept': '*/*',
          },
          body: JSON.stringify(requestBody),
        });
      }

      if (!res.ok) {
        const backendMessage = await parseHttpErrorBody(res);
        throw buildImageApiError(res.status, backendMessage);
      }

      return await res.json();
    });

    const imageData = extractImageFromOpenAiResponse(response);
    if (imageData) {
      return imageData;
    }

    throw new Error('图片生成失败：OpenAI Images 未返回有效图片数据。');
  }

  // Agnes AI protocol (extra_body.image)
  if (apiFormat === 'agnes') {
    const hasAgnesReferences = Boolean(options.referenceImages?.length);
    const agnesSize = mapAspectRatioToOpenAiImageSize(aspectRatio);

    const requestBody: any = {
      model: apiModel,
      prompt: finalPrompt,
      size: agnesSize,
    };

    // Agnes AI 使用 extra_body.image 传递参考图
    if (hasAgnesReferences) {
      requestBody.extra_body = {
        image: options.referenceImages,
        response_format: 'b64_json',
      };
    } else {
      requestBody.return_base64 = true;
    }

    const response = await retryOperation(async () => {
      const res = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': '*/*',
        },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        const backendMessage = await parseHttpErrorBody(res);
        throw buildImageApiError(res.status, backendMessage);
      }

      return await res.json();
    });

    const agnesImage = extractImageFromOpenAiResponse(response);
    if (agnesImage) {
      return agnesImage;
    }

    throw new Error('图片生成失败：Agnes AI 未返回有效图片数据。');
  }

  // Gemini generateContent protocol
  const parts: any[] = [{ text: finalPrompt }];
  if (options.referenceImages) {
    options.referenceImages.forEach((imgUrl) => {
      const match = imgUrl.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    });
  }

  const requestBody: any = {
    contents: [{
      role: 'user',
      parts: parts,
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio,
      },
    },
  };

  const response = await retryOperation(async () => {
    const res = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': '*/*',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const backendMessage = await parseHttpErrorBody(res);
      throw buildImageApiError(res.status, backendMessage);
    }

    return await res.json();
  });

  const candidates = response.candidates || [];
  if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts) {
    for (const part of candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }

  const hasSafetyBlock =
    !!response?.promptFeedback?.blockReason ||
    candidates.some((candidate: any) => {
      const finishReason = String(candidate?.finishReason || '').toUpperCase();
      return finishReason.includes('SAFETY') || finishReason.includes('BLOCK');
    });

  if (hasSafetyBlock) {
    throw new Error('图片生成失败：提示词可能被风控拦截，请修改提示词后重试。');
  }

  throw new Error('图片生成失败：未返回有效图片数据，请重试或调整提示词。');
};

/**
 * 检查宽高比是否支持
 */
export const isAspectRatioSupported = (
  aspectRatio: AspectRatio,
  model?: ImageModelDefinition
): boolean => {
  const activeModel = model || getActiveImageModel();
  if (!activeModel) return false;

  return activeModel.params.supportedAspectRatios.includes(aspectRatio);
};
