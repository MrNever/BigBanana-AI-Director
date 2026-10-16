import { AspectRatio, VideoDuration } from '../types';

export type PromptLintSeverity = 'error' | 'warning' | 'info';

export interface PromptLintIssue {
  code: string;
  severity: PromptLintSeverity;
  message: string;
  suggestion?: string;
}

export interface PromptLintResult {
  issues: PromptLintIssue[];
  errorCount: number;
  warningCount: number;
  canProceed: boolean;
}

export interface KeyframePreflightInput {
  prompt: string;
  negativePrompt?: string;
  hasCharacters: boolean;
  frameType: 'start' | 'end';
  hasStartFrameImage: boolean;
  referenceImageCount: number;
  aspectRatio: AspectRatio;
  supportedAspectRatios?: AspectRatio[];
}

export interface VideoPreflightInput {
  prompt: string;
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  modelId: string;
  supportsEndFrame: boolean;
  aspectRatio: AspectRatio;
  supportedAspectRatios?: AspectRatio[];
  duration: VideoDuration;
  supportedDurations?: VideoDuration[];
}

const HUMAN_EXCLUSION_TERMS = [
  'person',
  'people',
  'human',
  'man',
  'woman',
  'child',
  'character',
  'silhouette',
  'crowd',
  'pedestrian',
];

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bto be filled\b/i,
  /未设置/,
  /待补充/,
  /待填写/,
];

// 允许常见省略号 `...` / `……`；仅标记明显异常的重复标点（如 ,,, / !!!! / ....）
const REPEATED_SYMBOLS_PATTERN = /([,!?;:，！？；：])\1{2,}|(\.)\2{3,}/;

const SEVERITY_LABEL: Record<PromptLintSeverity, string> = {
  error: '错误',
  warning: '警告',
  info: '提示',
};

const normalizePrompt = (prompt?: string) => (prompt || '').trim();

const splitBySeparators = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(/[,;，；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
};

export const hasHumanExclusionTerms = (negativePrompt?: string): boolean => {
  if (!negativePrompt) return false;
  const tokens = splitBySeparators(negativePrompt.toLowerCase());
  return tokens.some((token) =>
    HUMAN_EXCLUSION_TERMS.some((keyword) => token.includes(keyword))
  );
};

export const lintPromptText = (
  prompt: string,
  options?: {
    minLength?: number;
    maxLength?: number;
    allowEmpty?: boolean;
  }
): PromptLintResult => {
  const minLength = options?.minLength ?? 16;
  const maxLength = options?.maxLength ?? 2200;
  const allowEmpty = options?.allowEmpty ?? false;

  const normalized = normalizePrompt(prompt);
  const issues: PromptLintIssue[] = [];

  if (!normalized) {
    if (!allowEmpty) {
      issues.push({
        code: 'empty-prompt',
        severity: 'error',
        message: '提示词为空。',
        suggestion: '生成前请先填写清晰的画面/动作描述。',
      });
    }
    return buildLintResult(issues);
  }

  if (normalized.length < minLength) {
    issues.push({
      code: 'prompt-too-short',
      severity: 'warning',
      message: `提示词过短（${normalized.length} 字符）。`,
      suggestion: '补充场景细节、主体动作与构图线索。',
    });
  }

  if (normalized.length > maxLength) {
    issues.push({
      code: 'prompt-too-long',
      severity: 'warning',
      message: `提示词过长（${normalized.length} 字符）。`,
      suggestion: '删除重复表述，只保留可执行的画面细节。',
    });
  }

  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    issues.push({
      code: 'placeholder-text',
      severity: 'warning',
      message: '提示词中仍包含占位文本。',
      suggestion: '将占位内容替换为具体的视觉描述。',
    });
  }

  if (REPEATED_SYMBOLS_PATTERN.test(normalized)) {
    issues.push({
      code: 'repeated-symbols',
      severity: 'info',
      message: '提示词存在异常重复标点。',
      suggestion: '清理多余标点，提高提示词可读性。',
    });
  }

  return buildLintResult(issues);
};

export const runKeyframePreflight = (input: KeyframePreflightInput): PromptLintResult => {
  const promptLint = lintPromptText(input.prompt);
  const issues: PromptLintIssue[] = [...promptLint.issues];

  if (
    input.supportedAspectRatios?.length &&
    !input.supportedAspectRatios.includes(input.aspectRatio)
  ) {
    issues.push({
      code: 'unsupported-aspect-ratio',
      severity: 'error',
      message: `当前图片模型不支持画幅 ${input.aspectRatio}。`,
      suggestion: `请改用：${input.supportedAspectRatios.join(', ')}`,
    });
  }

  if (input.hasCharacters && hasHumanExclusionTerms(input.negativePrompt)) {
    issues.push({
      code: 'negative-conflict-human',
      severity: 'warning',
      message: '负面提示词含“排除人物”类词，但本镜头绑定了角色。',
      suggestion: '角色镜头请去掉 person/human 等排除人物词。',
    });
  }

  if (input.referenceImageCount === 0) {
    issues.push({
      code: 'no-reference-images',
      severity: 'warning',
      message: '本关键帧未提供参考图。',
      suggestion: '建议绑定场景/角色/道具参考图，提升一致性。',
    });
  }

  if (input.frameType === 'end' && !input.hasStartFrameImage) {
    issues.push({
      code: 'end-without-start-image',
      severity: 'warning',
      message: '尚未有起始帧图片就开始生成结束帧。',
      suggestion: '建议先生成或上传起始帧，以保证连贯性。',
    });
  }

  return buildLintResult(issues);
};

export const runVideoPreflight = (input: VideoPreflightInput): PromptLintResult => {
  const promptLint = lintPromptText(input.prompt, { minLength: 20, maxLength: 2600 });
  const issues: PromptLintIssue[] = [...promptLint.issues];

  if (!input.hasStartFrame) {
    issues.push({
      code: 'missing-start-frame',
      severity: 'error',
      message: '缺少起始帧图片。',
      suggestion: '生成视频前请先生成或上传起始帧。',
    });
  }

  if (
    input.supportedAspectRatios?.length &&
    !input.supportedAspectRatios.includes(input.aspectRatio)
  ) {
    issues.push({
      code: 'unsupported-video-aspect-ratio',
      severity: 'error',
      message: `模型 ${input.modelId} 不支持画幅 ${input.aspectRatio}。`,
      suggestion: `请改用：${input.supportedAspectRatios.join(', ')}`,
    });
  }

  if (
    input.supportedDurations?.length &&
    !input.supportedDurations.includes(input.duration)
  ) {
    issues.push({
      code: 'unsupported-video-duration',
      severity: 'error',
      message: `模型 ${input.modelId} 不支持时长 ${input.duration} 秒。`,
      suggestion: `请改用：${input.supportedDurations.join(', ')} 秒`,
    });
  }

  if (input.hasEndFrame && !input.supportsEndFrame) {
    issues.push({
      code: 'end-frame-ignored',
      severity: 'info',
      message: `模型 ${input.modelId} 仅使用起始帧，结束帧将被忽略。`,
    });
  }

  return buildLintResult(issues);
};

export const formatLintIssues = (issues: PromptLintIssue[]): string =>
  issues
    .map((issue) => `- [${SEVERITY_LABEL[issue.severity]}] ${issue.message}`)
    .join('\n');

/** 仅返回需要用户关注的问题（警告及以上），info 不弹 toast */
export const getActionableLintIssues = (issues: PromptLintIssue[]): PromptLintIssue[] =>
  issues.filter((issue) => issue.severity === 'error' || issue.severity === 'warning');

const buildLintResult = (issues: PromptLintIssue[]): PromptLintResult => {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  return {
    issues,
    errorCount,
    warningCount,
    canProceed: errorCount === 0,
  };
};
