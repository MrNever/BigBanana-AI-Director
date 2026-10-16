/**
 * 视频生成服务
 * 包含同步（chat/completions）和异步（/v1/videos、任务接口）模式
 */

import { AspectRatio, VideoDuration } from "../../types";
import {
  retryOperation,
  checkApiKey,
  getApiBase,
  resolveModel,
  resolveRequestModel,
  parseHttpError,
  convertVideoUrlToBase64,
  resizeImageToSize,
  getSoraVideoSize,
} from './apiCore';
import { toFriendlyModerationMessage } from '../errorMessageService';

const VOLCENGINE_TASK_DEFAULT_ENDPOINT = '/api/v3/contents/generations/tasks';
const VOLCENGINE_DEFAULT_MODEL = 'doubao-seedance-1-5-pro-251215';
const SORA_COMPATIBLE_VIDEO_MODELS = new Set([
  'sora-2',
  'doubao-seedance-1-5-pro',
]);
const AGNES_DEFAULT_MAX_REFERENCE_IMAGES = 5;
const AGNES_DEFAULT_MAX_REFERENCE_AUDIOS = 3;
const AGNES_FLASH_FIXED_SIZE = '720P';

const isSoraCompatibleVideoModel = (modelName: string): boolean =>
  SORA_COMPATIBLE_VIDEO_MODELS.has((modelName || '').trim().toLowerCase());

const isAgnesVideoModel = (modelName: string): boolean =>
  (modelName || '').trim().toLowerCase().startsWith('agnes-video');

const isAgnesFlashVideoModel = (modelName: string): boolean =>
  (modelName || '').trim().toLowerCase().includes('agnes-video') &&
  (modelName || '').trim().toLowerCase().includes('flash');

const toFriendlyVideoErrorMessage = (message: string): string =>
  toFriendlyModerationMessage(message) || message;

/**
 * Agnes reference 模式参考图截断：刊例价免费额 / Flash 硬上限均为 5 张。
 * 保留顺序靠前的图（调用方应按优先级排列：关键帧 > 场景 > 角色 > 道具）。
 */
export const limitAgnesReferenceImages = (
  images: string[],
  maxImages: number = AGNES_DEFAULT_MAX_REFERENCE_IMAGES
): { images: string[]; droppedCount: number; maxImages: number } => {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const img of images || []) {
    const normalized = String(img || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  const limited = deduped.slice(0, Math.max(0, maxImages));
  return {
    images: limited,
    droppedCount: Math.max(0, deduped.length - limited.length),
    maxImages,
  };
};

const clampAgnesSeconds = (duration: VideoDuration): string => {
  const n = Number(duration);
  if (!Number.isFinite(n)) return '5';
  return String(Math.min(12, Math.max(4, Math.round(n))));
};

const resolveAgnesAspectRatio = (aspectRatio: AspectRatio): string => {
  if (aspectRatio === '9:16' || aspectRatio === '1:1' || aspectRatio === '16:9') {
    return aspectRatio;
  }
  return '16:9';
};

const buildAgnesVideoRequestBody = (
  modelName: string,
  prompt: string,
  references: string[],
  aspectRatio: AspectRatio,
  duration: VideoDuration,
  options?: {
    maxReferenceImages?: number;
    fixedSize?: string;
    extraReferenceImages?: string[];
  }
): { body: Record<string, unknown>; droppedReferenceCount: number } => {
  const maxImages = options?.maxReferenceImages ?? AGNES_DEFAULT_MAX_REFERENCE_IMAGES;
  const size = options?.fixedSize || AGNES_FLASH_FIXED_SIZE;
  const seconds = clampAgnesSeconds(duration);
  const aspect_ratio = resolveAgnesAspectRatio(aspectRatio);
  const startFrame = references[0];
  const endFrame = references[1];

  // 有首/尾帧时优先 keyframe（不走 images[]，避免 reference 5 张硬上限误伤）
  if (startFrame || endFrame) {
    const body: Record<string, unknown> = {
      model: modelName,
      prompt,
      mode: 'keyframe',
      seconds,
      size,
      aspect_ratio,
      n: 1,
    };
    if (startFrame) body.first_frame = startFrame;
    if (endFrame) body.last_frame = endFrame;
    return { body, droppedReferenceCount: 0 };
  }

  // 无关键帧时：纯文生，或把额外资产参考图走 reference 模式（硬截断到上限）
  const limited = limitAgnesReferenceImages(options?.extraReferenceImages || [], maxImages);
  if (limited.images.length > 0) {
    return {
      body: {
        model: modelName,
        prompt,
        mode: 'reference',
        seconds,
        size,
        aspect_ratio,
        n: 1,
        images: limited.images,
      },
      droppedReferenceCount: limited.droppedCount,
    };
  }

  return {
    body: {
      model: modelName,
      prompt,
      mode: 'text',
      seconds,
      size,
      aspect_ratio,
      n: 1,
    },
    droppedReferenceCount: 0,
  };
};

const mapVolcengineRatio = (
  aspectRatio: AspectRatio,
  hasImageInput: boolean
): '16:9' | '9:16' | 'adaptive' => {
  if (hasImageInput) return 'adaptive';
  return aspectRatio === '9:16' ? '9:16' : '16:9';
};

const tryConvertVideoUrlToBase64 = async (
  videoUrl: string,
  label: string
): Promise<string> => {
  try {
    const videoBase64 = await convertVideoUrlToBase64(videoUrl);
    console.log(`✅ ${label} 视频已转换为base64格式`);
    return videoBase64;
  } catch (error: any) {
    // 浏览器直接请求 TOS 常出现 CORS，保留 URL 继续流程，避免整次生成失败
    const message = error?.message || String(error);
    console.warn(`⚠️ ${label} 视频转base64失败，回退为原始URL: ${message}`);
    return videoUrl;
  }
};

// ============================================
// 异步视频生成
// ============================================

/**
 * 异步视频生成（单图走 sora-2，双图走 veo_3_1-fast）
 * 流程：1. 创建任务 -> 2. 轮询状态 -> 3. 下载视频
 */
const generateVideoAsync = async (
  prompt: string,
  startImageBase64: string | undefined,
  endImageBase64: string | undefined,
  apiKey: string,
  aspectRatio: AspectRatio = '16:9',
  duration: VideoDuration = 8,
  modelName: string = 'sora-2'
): Promise<string> => {
  let references = [startImageBase64, endImageBase64].filter(Boolean) as string[];
  const resolvedModelName = modelName || 'sora-2';
  const isSoraCompatibleModel = isSoraCompatibleVideoModel(resolvedModelName);
  const useReferenceArray = resolvedModelName.toLowerCase().startsWith('veo_3_1-fast');
  if (isSoraCompatibleModel && references.length >= 2) {
    console.warn('⚠️ Capability routing: sora-2 only supports start-frame reference. End-frame reference will be ignored.');
    references = references.slice(0, 1);
  }

  if (isSoraCompatibleModel && references.length >= 2) {
    throw new Error('Sora-2 不支持首尾帧模式，请只传一张参考图。');
  }

  console.log(`🎬 使用异步模式生成视频 (${resolvedModelName}, ${aspectRatio}, ${duration}秒)...`);

  const videoSize = getSoraVideoSize(aspectRatio);
  const [VIDEO_WIDTH, VIDEO_HEIGHT] = videoSize.split('x').map(Number);

  console.log(`📐 视频尺寸: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);

  const apiBase = getApiBase('video', resolvedModelName);
  const isAgnes = isAgnesVideoModel(resolvedModelName);

  // Step 1: 创建视频任务
  let createResponse: Response;

  if (isAgnes) {
    // Agnes Video 2.5 / Flash：OpenAI Videos 兼容 JSON（text / keyframe / reference）
    // Flash 强制 720P；reference.images 最多 5 张（刊例价免费图额同为 5）
    const modelParams = (resolveModel('video', resolvedModelName)?.params || {}) as {
      maxReferenceImages?: number;
      fixedSize?: string;
    };
    const { body: requestBody, droppedReferenceCount } = buildAgnesVideoRequestBody(
      resolvedModelName,
      prompt,
      references,
      aspectRatio,
      duration,
      {
        maxReferenceImages: modelParams.maxReferenceImages ?? AGNES_DEFAULT_MAX_REFERENCE_IMAGES,
        fixedSize:
          modelParams.fixedSize ||
          (isAgnesFlashVideoModel(resolvedModelName) ? AGNES_FLASH_FIXED_SIZE : AGNES_FLASH_FIXED_SIZE),
      }
    );

    if (droppedReferenceCount > 0) {
      console.warn(
        `⚠️ Agnes 参考图超过上限 ${modelParams.maxReferenceImages ?? AGNES_DEFAULT_MAX_REFERENCE_IMAGES}，已截断 ${droppedReferenceCount} 张`
      );
    }

    console.log('🎬 使用 Agnes AI 创建任务:', {
      model: resolvedModelName,
      mode: requestBody.mode,
      size: requestBody.size,
      aspect_ratio: requestBody.aspect_ratio,
      seconds: requestBody.seconds,
      imageCount: Array.isArray(requestBody.images) ? requestBody.images.length : (requestBody.first_frame ? (requestBody.last_frame ? 2 : 1) : 0),
    });

    createResponse = await fetch(`${apiBase}/v1/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } else {
    // Sora/Gemini 使用 FormData
    const formData = new FormData();
    formData.append('model', resolvedModelName);
    formData.append('prompt', prompt);
    formData.append('seconds', String(duration));
    formData.append('size', videoSize);

    const appendReference = async (base64: string, filename: string, fieldName: string) => {
      const cleanBase64 = base64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      console.log(`📐 调整参考图片尺寸至 ${VIDEO_WIDTH}x${VIDEO_HEIGHT}...`);
      const resizedBase64 = await resizeImageToSize(cleanBase64, VIDEO_WIDTH, VIDEO_HEIGHT);
      const byteCharacters = atob(resizedBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'image/png' });
      formData.append(fieldName, blob, filename);
    };

    if (useReferenceArray && references.length >= 2) {
      const limited = references.slice(0, 2);
      await appendReference(limited[0], 'reference-start.png', 'input_reference[]');
      await appendReference(limited[1], 'reference-end.png', 'input_reference[]');
    } else if (references.length >= 1) {
      await appendReference(references[0], 'reference.png', 'input_reference');
    }

    if (references.length > 0) {
      console.log('✅ 参考图片已调整尺寸并添加');
    }

    createResponse = await fetch(`${apiBase}/v1/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });
  }

  if (!createResponse.ok) {
    let errorMessage = `创建任务失败: HTTP ${createResponse.status}`;
    let errorDetail = '';
    try {
      const errorData = await createResponse.json();
      errorDetail = String(errorData.detail || errorData.error?.message || errorData.message || '');
      errorMessage = errorDetail || errorMessage;
    } catch (e) {
      const errorText = await createResponse.text();
      if (errorText) errorMessage = errorText;
    }

    if (isAgnes && /images length must not exceed/i.test(errorDetail || errorMessage)) {
      throw new Error(
        `参考图超过 Agnes 上限（最多 ${AGNES_DEFAULT_MAX_REFERENCE_IMAGES} 张）。请减少参考图后重试；系统会优先保留关键帧。`
      );
    }
    if (isAgnes && /size must be 720P/i.test(errorDetail || errorMessage)) {
      throw new Error('Agnes Video Flash 仅支持 720P，请勿指定其他分辨率。');
    }
    if (isAgnes && /audios length must not exceed/i.test(errorDetail || errorMessage)) {
      throw new Error(
        `参考音频超过 Agnes 上限（最多 ${AGNES_DEFAULT_MAX_REFERENCE_AUDIOS} 段）。请减少音频后重试。`
      );
    }
    if (isAgnes && /videos is not supported/i.test(errorDetail || errorMessage)) {
      throw new Error('Agnes Video Flash 不支持参考视频输入，请仅使用图片或音频参考。');
    }

    if (createResponse.status === 400 && !isAgnes) {
      throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
    }
    if (createResponse.status === 500) {
      throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
    }
    throw new Error(toFriendlyVideoErrorMessage(errorMessage));
  }

  const createData = await createResponse.json();
  const taskId = createData.id || createData.task_id;
  const videoId = createData.video_id; // Agnes AI 返回 video_id

  if (!taskId && !(isAgnes && videoId)) {
    throw new Error('创建视频任务失败：未返回任务ID');
  }

  console.log(`📋 ${resolvedModelName} 任务已创建，任务ID:`, taskId || videoId);
  if (videoId) {
    console.log(`📹 视频ID:`, videoId);
  }

  // Step 2: 轮询查询任务状态
  const maxPollingTime = 1200000; // 20分钟超时
  const pollingInterval = 5000;
  const startTime = Date.now();

  let finalVideoId: string | null = videoId || null;
  let videoUrlFromStatus: string | null = null;

  while (Date.now() - startTime < maxPollingTime) {
    await new Promise(resolve => setTimeout(resolve, pollingInterval));

    // Agnes AI 使用 /agnesapi?video_id=<VIDEO_ID>
    const statusUrl = isAgnes && videoId
      ? `${apiBase}/agnesapi?video_id=${videoId}&model_name=${resolvedModelName}`
      : `${apiBase}/v1/videos/${taskId}`;

    const statusResponse = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!statusResponse.ok) {
      console.warn('⚠️ 查询任务状态失败，继续重试...');
      continue;
    }

    const statusData = await statusResponse.json();
    const status = statusData.status;

    console.log(`🔄 ${resolvedModelName} 任务状态:`, status, '进度:', statusData.progress);

    if (status === 'completed' || status === 'succeeded') {
      // Agnes：优先顶层 url，兼容旧字段 metadata.url
      if (isAgnes && (statusData.url || statusData.metadata?.url)) {
        videoUrlFromStatus = statusData.url || statusData.metadata?.url;
        console.log('✅ Agnes AI 任务完成，视频URL:', videoUrlFromStatus);
      } else {
        videoUrlFromStatus = statusData.video_url || statusData.videoUrl || statusData.url || null;
      }

      if (statusData.id && statusData.id.startsWith('video_')) {
        finalVideoId = statusData.id;
      } else {
        finalVideoId = statusData.output_video || statusData.video_id || statusData.outputs?.[0]?.id || statusData.id;
      }
      if (!finalVideoId && statusData.outputs && statusData.outputs.length > 0) {
        finalVideoId = statusData.outputs[0];
      }
      console.log('✅ 任务完成，视频ID:', finalVideoId);
      break;
    } else if (status === 'failed' || status === 'error') {
      const errorMessage =
        statusData?.error?.message ||
        statusData?.error?.code ||
        statusData?.message ||
        '未知错误';
      throw new Error(toFriendlyVideoErrorMessage(errorMessage));
    }
  }

  if (!finalVideoId && !videoUrlFromStatus) {
    throw new Error('视频生成超时 (20分钟) 或未返回视频ID');
  }

  console.log(`✅ ${resolvedModelName} 视频生成完成，视频ID:`, finalVideoId);

  if (videoUrlFromStatus) {
    return tryConvertVideoUrlToBase64(videoUrlFromStatus, resolvedModelName);
  }

  // Step 3: 下载视频内容
  const maxDownloadRetries = 5;
  const downloadTimeout = 600000;

  for (let attempt = 1; attempt <= maxDownloadRetries; attempt++) {
    try {
      console.log(`📥 尝试下载视频 (第${attempt}/${maxDownloadRetries}次)...`);

      const downloadController = new AbortController();
      const downloadTimeoutId = setTimeout(() => downloadController.abort(), downloadTimeout);

      const downloadResponse = await fetch(`${apiBase}/v1/videos/${finalVideoId}/content`, {
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Authorization': `Bearer ${apiKey}`
        },
        signal: downloadController.signal
      });

      clearTimeout(downloadTimeoutId);

      if (!downloadResponse.ok) {
        if (downloadResponse.status >= 500 && attempt < maxDownloadRetries) {
          console.warn(`⚠️ 下载失败 HTTP ${downloadResponse.status}，${5 * attempt}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        throw new Error(`下载视频失败: HTTP ${downloadResponse.status}`);
      }

      const contentType = downloadResponse.headers.get('content-type');

      if (contentType && contentType.includes('video')) {
        const videoBlob = await downloadResponse.blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            console.log(`✅ ${resolvedModelName} 视频已转换为base64格式`);
            resolve(result);
          };
          reader.onerror = () => reject(new Error('视频转base64失败'));
          reader.readAsDataURL(videoBlob);
        });
      } else {
        const downloadData = await downloadResponse.json();
        const videoUrl = downloadData.url || downloadData.video_url || downloadData.download_url;

        if (!videoUrl) {
          throw new Error('未获取到视频下载地址');
        }

        return tryConvertVideoUrlToBase64(videoUrl, resolvedModelName);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`⚠️ 下载超时，${5 * attempt}秒后重试...`);
        if (attempt < maxDownloadRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        throw new Error('下载视频超时 (10分钟)');
      }
      if (attempt === maxDownloadRetries) {
        throw error;
      }
      console.warn(`⚠️ 下载出错: ${error.message}，${5 * attempt}秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }

  throw new Error('下载视频失败：已达最大重试次数');
};

const normalizeEndpoint = (endpoint?: string, fallback: string = VOLCENGINE_TASK_DEFAULT_ENDPOINT): string => {
  const normalized = (endpoint || fallback).trim();
  if (!normalized) return fallback;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

const safeJsonParse = async (response: Response): Promise<any | null> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const getNestedValue = (obj: any, path: string): any => {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
};

const extractVideoUrlFromTaskPayload = (payload: any): string | null => {
  const candidatePaths = [
    'content.video_url',
    'content.videoUrl',
    'data.content.video_url',
    'data.content.videoUrl',
    'result.video_url',
    'result.videoUrl',
    'output.video_url',
    'output.videoUrl',
    'video_url',
    'videoUrl',
    'url',
  ];

  for (const path of candidatePaths) {
    const value = getNestedValue(payload, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

/**
 * 火山引擎任务模式视频生成
 * 流程：1) POST 创建任务 2) GET 轮询任务 3) 下载 video_url
 */
const generateVideoVolcengineTask = async (
  prompt: string,
  startImageBase64: string | undefined,
  endImageBase64: string | undefined,
  apiKey: string,
  apiBase: string,
  aspectRatio: AspectRatio = '16:9',
  duration: VideoDuration = 5,
  modelName: string = VOLCENGINE_DEFAULT_MODEL,
  endpoint: string = VOLCENGINE_TASK_DEFAULT_ENDPOINT
): Promise<string> => {
  const taskEndpoint = normalizeEndpoint(endpoint, VOLCENGINE_TASK_DEFAULT_ENDPOINT);

  if (endImageBase64) {
    console.warn('⚠️ Volcengine task mode currently uses start-frame only. End frame will be ignored.');
  }

  const normalizeImageUrl = (image: string): string => {
    if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('data:image/')) {
      return image;
    }
    const clean = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    return `data:image/png;base64,${clean}`;
  };

  const content: any[] = [
    {
      type: 'text',
      text: prompt,
    },
  ];

  if (startImageBase64) {
    content.push({
      type: 'image_url',
      image_url: {
        url: normalizeImageUrl(startImageBase64),
      },
    });
  }

  const hasImageInput = !!startImageBase64;
  const ratio = mapVolcengineRatio(aspectRatio, hasImageInput);

  const createResponse = await fetch(`${apiBase}${taskEndpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName || VOLCENGINE_DEFAULT_MODEL,
      content,
      ratio,
      duration,
      watermark: false,
    }),
  });

  if (!createResponse.ok) {
    if (createResponse.status === 400) {
      throw new Error('提示词或输入图片不符合要求，请调整后重试。');
    }
    if (createResponse.status >= 500) {
      throw new Error('火山引擎服务繁忙，请稍后重试。');
    }
    throw await parseHttpError(createResponse);
  }

  const createData = await safeJsonParse(createResponse);
  const taskId =
    createData?.id ||
    createData?.task_id ||
    createData?.data?.id ||
    createData?.data?.task_id;

  if (!taskId) {
    throw new Error('创建视频任务失败：未返回任务 ID');
  }

  console.log('📋 Volcengine 任务已创建，任务ID:', taskId);

  const pollingInterval = 5000;
  const maxPollingTime = 1200000; // 20 分钟
  const startTime = Date.now();
  const successStates = new Set(['succeeded', 'completed', 'success', 'done']);
  const failedStates = new Set(['failed', 'error', 'canceled', 'cancelled']);

  while (Date.now() - startTime < maxPollingTime) {
    await new Promise(resolve => setTimeout(resolve, pollingInterval));

    const statusResponse = await fetch(`${apiBase}${taskEndpoint}/${taskId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      console.warn('⚠️ Volcengine 任务查询失败，继续轮询...');
      continue;
    }

    const statusData = await safeJsonParse(statusResponse);
    const rawStatus = (
      statusData?.status ||
      statusData?.data?.status ||
      ''
    ).toString().toLowerCase();

    console.log('🔄 Volcengine 任务状态:', rawStatus || 'unknown');

    if (successStates.has(rawStatus)) {
      const videoUrl = extractVideoUrlFromTaskPayload(statusData);
      if (!videoUrl) {
        throw new Error('任务已完成，但未返回视频地址');
      }
      return tryConvertVideoUrlToBase64(videoUrl, 'Volcengine');
    }

    if (failedStates.has(rawStatus)) {
      const errorMessage =
        statusData?.error?.message ||
        statusData?.error?.code ||
        statusData?.message ||
        statusData?.msg ||
        '未知错误';
      throw new Error(toFriendlyVideoErrorMessage(errorMessage));
    }
  }

  throw new Error('视频生成超时 (20分钟)');
};

// ============================================
// 统一视频生成入口
// ============================================

/**
 * 生成视频
 * 支持同步（chat/completions）和异步（/v1/videos、任务接口）两种模式
 */
export const generateVideo = async (
  prompt: string,
  startImageBase64?: string,
  endImageBase64?: string,
  model: string = 'sora-2',
  aspectRatio: AspectRatio = '16:9',
  duration: VideoDuration = 8
): Promise<string> => {
  const resolvedVideoModel = resolveModel('video', model);
  const resolvedVideoModelId = (resolvedVideoModel as any)?.id || model;
  const requestModel = resolveRequestModel('video', model) || '';
  const apiKey = checkApiKey('video', model);
  const apiBase = getApiBase('video', model);
  const resolvedEndpoint = (resolvedVideoModel as any)?.endpoint || '';
  const normalizedRequestModel = (requestModel || resolvedVideoModelId || '').toLowerCase();
  const isSoraCompatibleModel = isSoraCompatibleVideoModel(normalizedRequestModel);
  const isVolcengineTaskMode =
    resolvedEndpoint.includes('/contents/generations/tasks') ||
    (normalizedRequestModel.startsWith('doubao-seedance') && !isSoraCompatibleModel);

  if (isVolcengineTaskMode) {
    return generateVideoVolcengineTask(
      prompt,
      startImageBase64,
      endImageBase64,
      apiKey,
      apiBase,
      aspectRatio,
      duration,
      requestModel || resolvedVideoModelId || VOLCENGINE_DEFAULT_MODEL,
      resolvedEndpoint || VOLCENGINE_TASK_DEFAULT_ENDPOINT
    );
  }

  const isAsyncMode =
    (resolvedVideoModel?.params as any)?.mode === 'async' ||
    isSoraCompatibleModel ||
    normalizedRequestModel.startsWith('veo_3_1-fast');

  // 异步模式
  if (isAsyncMode) {
    return generateVideoAsync(
      prompt,
      startImageBase64,
      endImageBase64,
      apiKey,
      aspectRatio,
      duration,
      requestModel || resolvedVideoModelId || 'sora-2'
    );
  }

  // 同步模式：直接使用模型配置中的请求模型名
  const actualModel = requestModel || resolvedVideoModelId || 'sora-2';

  const messages: any[] = [
    { role: 'user', content: prompt }
  ];

  const cleanStart = startImageBase64?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';
  const cleanEnd = endImageBase64?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';

  if (cleanStart) {
    messages[0].content = [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${cleanStart}` }
      }
    ];
  }

  if (cleanEnd) {
    if (Array.isArray(messages[0].content)) {
      messages[0].content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${cleanEnd}` }
      });
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200000);

  try {
    const response = await retryOperation(async () => {
      const res = await fetch(`${apiBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: actualModel,
          messages: messages,
          stream: false,
          temperature: 0.7
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        if (res.status === 400) {
          throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
        }
        else if (res.status === 500) {
          throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
        }

        let errorMessage = `HTTP错误: ${res.status}`;
        try {
          const errorData = await res.json();
          errorMessage = errorData.error?.message || errorMessage;
        } catch (e) {
          const errorText = await res.text();
          if (errorText) errorMessage = errorText;
        }
        throw new Error(toFriendlyVideoErrorMessage(errorMessage));
      }

      return res;
    });

    clearTimeout(timeoutId);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    const urlMatch = content.match(/(https?:\/\/[^\s]+\.mp4)/);
    const videoUrl = urlMatch ? urlMatch[1] : '';

    if (!videoUrl) {
      throw new Error("视频生成失败 (No video URL returned)");
    }

    console.log('🎬 视频URL获取成功,正在转换为base64...');

    try {
      const videoBase64 = await convertVideoUrlToBase64(videoUrl);
      console.log('✅ 视频已转换为base64格式,可安全存储到IndexedDB');
      return videoBase64;
    } catch (error: any) {
      console.error('❌ 视频转base64失败,返回原始URL:', error);
      return videoUrl;
    }
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('视频生成超时 (20分钟)');
    }
    throw error;
  }
};
