import { ProjectState } from '../types';
import { dataUrlToBlob, isOpfsVideoRef, isVideoDataUrl, resolveVideoToBlob } from './videoStorageService';
import { fetchMediaWithCorsFallback } from './mediaFetchService';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type ProgressReporter = (phase: string, progress: number) => void;

interface MasterVideoFormat {
  mimeType: string;
  extension: string;
}

export type MasterExportMode = 'master-video' | 'segments-zip';
export type MasterVideoQuality = 'economy' | 'balanced' | 'pro';
export type MasterVideoOutputFormat = 'webm' | 'mp4';

interface MasterQualityPreset {
  fps: number;
  videoBitsPerSecond: number;
  label: string;
}

export interface MasterExportOptions {
  mode?: MasterExportMode;
  quality?: MasterVideoQuality;
  outputFormat?: MasterVideoOutputFormat;
}

const MASTER_QUALITY_PRESETS: Record<MasterVideoQuality, MasterQualityPreset> = {
  economy: {
    fps: 24,
    videoBitsPerSecond: 4_000_000,
    label: 'Economy',
  },
  balanced: {
    fps: 30,
    videoBitsPerSecond: 8_000_000,
    label: 'Balanced',
  },
  pro: {
    fps: 30,
    videoBitsPerSecond: 14_000_000,
    label: 'Pro',
  },
};

const MASTER_VIDEO_FORMATS: MasterVideoFormat[] = [
  { mimeType: 'video/webm;codecs=vp9,opus', extension: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
];

const canStitchMasterVideo = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof document === 'undefined') return false;
  if (typeof MediaRecorder === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return typeof canvas.captureStream === 'function';
};

const pickMasterVideoFormat = (): MasterVideoFormat | null => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const format of MASTER_VIDEO_FORMATS) {
    if (MediaRecorder.isTypeSupported(format.mimeType)) {
      return format;
    }
  }
  return null;
};

const createProjectTitle = (project: ProjectState): string => (
  project.scriptData?.title || project.title || 'master'
);

// FFmpeg instance (singleton)
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoaded = false;

/**
 * Initialize FFmpeg.wasm instance
 */
const loadFFmpeg = async (onProgress?: ProgressReporter): Promise<FFmpeg> => {
  if (ffmpegInstance && ffmpegLoaded) {
    console.log('[FFmpeg] Using cached instance');
    return ffmpegInstance;
  }

  console.log('[FFmpeg] Starting to load...');
  onProgress?.('正在加载 FFmpeg...', 1);
  
  const ffmpeg = new FFmpeg();
  
  ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg Log]', message);
  });

  // 多个 CDN 源以提高成功率
  const cdnSources = [
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd',
  ];
  
  onProgress?.('下载 FFmpeg 核心文件...', 3);
  
  // 添加超时控制
  const loadWithTimeout = async (promise: Promise<any>, timeoutMs: number, description: string) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`${description} 超时 (${timeoutMs/1000}s)`)), timeoutMs)
      )
    ]);
  };
  
  // 尝试多个 CDN 源
  let lastError: Error | null = null;
  for (let i = 0; i < cdnSources.length; i++) {
    const baseURL = cdnSources[i];
    console.log(`[FFmpeg] Trying CDN ${i + 1}/${cdnSources.length}: ${baseURL}`);
    
    try {
      const coreURL = await loadWithTimeout(
        toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        30000,
        '下载核心 JS 文件'
      );
      console.log('[FFmpeg] Core JS loaded');
      onProgress?.('下载 WASM 文件 (约 30MB)...', 5);
      
      const wasmURL = await loadWithTimeout(
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        60000,
        '下载 WASM 文件'
      );
      console.log('[FFmpeg] WASM loaded, initializing...');
      onProgress?.('初始化 FFmpeg 引擎...', 7);
      
      await loadWithTimeout(
        ffmpeg.load({
          coreURL,
          wasmURL,
        }),
        30000,
        'FFmpeg 初始化'
      );
      console.log('[FFmpeg] Load completed successfully');
      
      onProgress?.('FFmpeg 就绪', 8);
      ffmpegInstance = ffmpeg;
      ffmpegLoaded = true;
      return ffmpeg;
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('未知错误');
      console.warn(`[FFmpeg] CDN ${i + 1} failed:`, lastError.message);
      if (i < cdnSources.length - 1) {
        onProgress?.(`CDN ${i + 1} 失败，尝试备用源...`, 3);
      }
    }
  }
  
  // 所有源都失败
  console.error('[FFmpeg] All CDN sources failed');
  const errorMsg = lastError?.message || '未知错误';
  throw new Error(`FFmpeg 加载失败: ${errorMsg}。建议使用 WebM 格式导出。`);
};

/**
 * Convert WebM blob to MP4 using FFmpeg.wasm
 */
const convertWebMToMP4 = async (
  webmBlob: Blob,
  quality: MasterVideoQuality = 'balanced',
  onProgress?: ProgressReporter
): Promise<Blob> => {
  let ffmpeg: FFmpeg | null = null;
  
  try {
    console.log('[MP4 Conversion] Starting conversion, blob size:', webmBlob.size);
    ffmpeg = await loadFFmpeg(onProgress);
    
    onProgress?.('准备转换视频...', 10);
    console.log('[MP4 Conversion] Writing input file...');
    
    // Write input file
    const inputName = 'input.webm';
    const outputName = 'output.mp4';
    await ffmpeg.writeFile(inputName, await fetchFile(webmBlob));
    console.log('[MP4 Conversion] Input file written');
    
    onProgress?.('开始转换为 MP4...', 15);
    
    // Quality presets for MP4 (H.264)
    const qualityPresets = {
      economy: { crf: '28', preset: 'fast' },
      balanced: { crf: '23', preset: 'medium' },
      pro: { crf: '18', preset: 'slow' },
    };
    
    const preset = qualityPresets[quality] || qualityPresets.balanced;
    console.log('[MP4 Conversion] Using preset:', quality, preset);
    
    // Set up progress tracking - register BEFORE exec
    let lastProgress = 15;
    const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
      // FFmpeg progress is 0-1, map to 15-90 range
      const currentProgress = 15 + Math.round(progress * 75);
      if (currentProgress > lastProgress) {
        lastProgress = currentProgress;
        const seconds = Math.floor(time / 1000000);
        console.log('[MP4 Conversion] Progress:', currentProgress, '% Time:', seconds, 's');
        onProgress?.(`转换为 MP4 (${seconds}s)...`, currentProgress);
      }
    };
    
    ffmpeg.on('progress', progressHandler);
    console.log('[MP4 Conversion] Starting FFmpeg exec...');
    
    // Convert with H.264 encoding
    await ffmpeg.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', preset.preset,
      '-crf', preset.crf,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputName
    ]);
    
    console.log('[MP4 Conversion] FFmpeg exec completed');
    
    // Remove progress handler
    ffmpeg.off('progress', progressHandler);
    
    onProgress?.('读取转换后的文件...', 92);
    console.log('[MP4 Conversion] Reading output file...');
    
    // Read output file
    const data = await ffmpeg.readFile(outputName);
    const mp4Blob = new Blob([data], { type: 'video/mp4' });
    console.log('[MP4 Conversion] Output file size:', mp4Blob.size);
    
    // Clean up
    try {
      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
      console.log('[MP4 Conversion] Temporary files cleaned up');
    } catch (cleanupError) {
      console.warn('[MP4 Conversion] Failed to clean up temporary files:', cleanupError);
    }
    
    onProgress?.('转换完成', 100);
    console.log('[MP4 Conversion] Conversion completed successfully');
    
    return mp4Blob;
  } catch (error) {
    console.error('[MP4 Conversion] Conversion failed:', error);
    // Try to clean up on error
    if (ffmpeg) {
      try {
        await ffmpeg.deleteFile('input.webm').catch(() => {});
        await ffmpeg.deleteFile('output.mp4').catch(() => {});
      } catch {}
    }
    throw new Error(`视频转换失败: ${error instanceof Error ? error.message : '未知错误'}`);
  }
};

const inferDubbingExtension = (shot: ProjectState['shots'][number]): 'wav' | 'mp3' => {
  const configured = shot.dubbing?.outputFormat;
  if (configured === 'wav' || configured === 'mp3') {
    return configured;
  }

  const audioUrl = shot.dubbing?.audioUrl || '';
  const lower = audioUrl.toLowerCase();
  if (lower.startsWith('data:audio/mpeg') || lower.startsWith('data:audio/mp3')) {
    return 'mp3';
  }
  if (lower.startsWith('data:audio/wav') || lower.startsWith('data:audio/x-wav')) {
    return 'wav';
  }

  const extMatch = lower.match(/\.([a-z0-9]{2,4})(?:$|\?)/);
  if (extMatch?.[1] === 'mp3') return 'mp3';
  if (extMatch?.[1] === 'wav') return 'wav';

  return 'wav';
};

/**
 * Download one media input and normalize it to Blob.
 * Supports remote URL, data URL, and OPFS-backed references.
 */
async function downloadFile(urlOrBase64: string): Promise<Blob> {
  if (isVideoDataUrl(urlOrBase64) || isOpfsVideoRef(urlOrBase64)) {
    return resolveVideoToBlob(urlOrBase64);
  }
  if (urlOrBase64.startsWith('data:')) {
    try {
      return dataUrlToBlob(urlOrBase64);
    } catch {
      const fallbackResponse = await fetch(urlOrBase64);
      if (!fallbackResponse.ok) {
        throw new Error(`Download failed: ${fallbackResponse.statusText}`);
      }
      return await fallbackResponse.blob();
    }
  }
  // Download from remote URL (with dev-time CORS fallback).
  const response = await fetchMediaWithCorsFallback(urlOrBase64);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`);
  }
  return await response.blob();
}

const loadVideoElement = (blob: Blob): Promise<{ video: HTMLVideoElement; revoke: () => void }> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(blob);
    let settled = false;

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
    };

    video.preload = 'auto';
    video.muted = false;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    video.onloadedmetadata = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        video,
        revoke: () => URL.revokeObjectURL(objectUrl),
      });
    };

    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to read video segment metadata'));
    };

    video.src = objectUrl;
  });
};

type VideoAudioAttach = (video: HTMLVideoElement) => (() => void) | void;

const renderVideoSegmentToCanvas = async (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  attachAudio?: VideoAudioAttach
): Promise<void> => {
  const detachAudio = attachAudio?.(video);
  try {
    await video.play();
  } catch (error) {
    if (typeof detachAudio === 'function') {
      detachAudio();
    }
    throw error;
  }

  return new Promise<void>((resolve, reject) => {
    let rafId = 0;

    const cleanup = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      video.onended = null;
      video.onerror = null;
    };

    const drawFrame = () => {
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      if (!video.paused && !video.ended) {
        rafId = requestAnimationFrame(drawFrame);
      }
    };

    video.onended = () => {
      cleanup();
      if (typeof detachAudio === 'function') {
        detachAudio();
      }
      resolve();
    };

    video.onerror = () => {
      cleanup();
      if (typeof detachAudio === 'function') {
        detachAudio();
      }
      reject(new Error('Failed to render video segment'));
    };

    drawFrame();
  });
};

const stitchVideoBlobsToMaster = async (
  videoBlobs: Blob[],
  quality: MasterVideoQuality = 'balanced',
  onProgress?: ProgressReporter
): Promise<{ blob: Blob; extension: string }> => {
  const format = pickMasterVideoFormat();
  if (!format) {
    throw new Error('Browser does not support master video encoding. Please export segments ZIP instead.');
  }
  if (videoBlobs.length === 0) {
    throw new Error('No video segments available for stitching.');
  }

  const qualityPreset = MASTER_QUALITY_PRESETS[quality] || MASTER_QUALITY_PRESETS.balanced;
  onProgress?.(`Initializing stitcher (${qualityPreset.label})...`, 50);

  const firstSegment = await loadVideoElement(videoBlobs[0]);
  const firstVideo = firstSegment.video;
  const width = Math.max(1, Math.round(firstVideo.videoWidth || 1280));
  const height = Math.max(1, Math.round(firstVideo.videoHeight || 720));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    firstSegment.revoke();
    throw new Error('Failed to create canvas for stitching.');
  }

  const canvasStream = canvas.captureStream(qualityPreset.fps);
  const recorderStream = new MediaStream();
  canvasStream.getVideoTracks().forEach((track) => recorderStream.addTrack(track));

  const AudioContextCtor =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('AudioContext is unavailable. Cannot export audio-preserving master in this browser.');
  }
  let audioContext: AudioContext | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;

  try {
    audioContext = new AudioContextCtor() as AudioContext;
    audioDestination = audioContext.createMediaStreamDestination();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const [audioTrack] = audioDestination.stream.getAudioTracks();
    if (!audioTrack) {
      throw new Error('Audio destination did not provide a track.');
    }
    recorderStream.addTrack(audioTrack);
  } catch (error) {
    throw new Error(`Failed to initialize audio pipeline for master export: ${String((error as any)?.message || error)}`);
  }

  const attachAudio: VideoAudioAttach = (video) => {
    if (!audioContext || !audioDestination) {
      throw new Error('Audio pipeline is not ready.');
    }
    try {
      const source = audioContext.createMediaElementSource(video);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 1;
      source.connect(gainNode);
      gainNode.connect(audioDestination);
      return () => {
        source.disconnect();
        gainNode.disconnect();
      };
    } catch (error) {
      throw new Error(`Failed to attach segment audio: ${String((error as any)?.message || error)}`);
    }
  };

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(recorderStream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: qualityPreset.videoBitsPerSecond,
  });

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('Master video encoding failed'));
  });

  try {
    recorder.start(1000);
    for (let i = 0; i < videoBlobs.length; i++) {
      onProgress?.(
        `Stitching segment (${i + 1}/${videoBlobs.length})...`,
        50 + Math.round(((i + 1) / videoBlobs.length) * 40)
      );

      const segment = i === 0 ? firstSegment : await loadVideoElement(videoBlobs[i]);
      const video = segment.video;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        await renderVideoSegmentToCanvas(video, canvas, ctx, attachAudio);
      } finally {
        segment.revoke();
      }
    }
  } catch (error) {
    firstSegment.revoke();
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    recorderStream.getTracks().forEach((track) => track.stop());
    if (audioContext) {
      void audioContext.close().catch(() => undefined);
    }
    throw error;
  }

  if (recorder.state !== 'inactive') {
    recorder.stop();
  }
  await stopped;
  recorderStream.getTracks().forEach((track) => track.stop());
  if (audioContext) {
    await audioContext.close().catch(() => undefined);
  }

  const masterBlob = new Blob(chunks, { type: format.mimeType });
  if (masterBlob.size === 0) {
    throw new Error('Master video generation failed: empty output.');
  }

  return {
    blob: masterBlob,
    extension: format.extension,
  };
};

const downloadMasterVideoAsZip = async (
  project: ProjectState,
  completedShots: ProjectState['shots'],
  onProgress?: ProgressReporter
): Promise<void> => {
  onProgress?.('Environment does not support single-file stitch. Exporting segments ZIP...', 50);

  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  for (let i = 0; i < completedShots.length; i++) {
    const shot = completedShots[i];
    const videoUrl = shot.interval!.videoUrl!;
    const shotNum = String(i + 1).padStart(3, '0');
    const fileName = `shot_${shotNum}.mp4`;

    try {
      const videoBlob = await downloadFile(videoUrl);
      zip.file(fileName, videoBlob);
    } catch (err) {
      console.error(`Failed to download segment ${i + 1}:`, err);
    }

    const progress = 50 + Math.round(((i + 1) / completedShots.length) * 35);
    onProgress?.(`Downloading (${i + 1}/${completedShots.length})...`, progress);
  }

  onProgress?.('Generating ZIP file...', 88);

  const zipBlob = await zip.generateAsync(
    { type: 'blob' },
    (metadata) => {
      const progress = 88 + Math.round(metadata.percent / 8);
      onProgress?.('Compressing...', progress);
    }
  );

  onProgress?.('Preparing download...', 98);

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${createProjectTitle(project)}_segments.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Export timeline videos.
 * `master-video`: stitch all segments into one master file.
 * `segments-zip`: package all rendered segments into ZIP.
 */
export async function downloadMasterVideo(
  project: ProjectState,
  onProgress?: (phase: string, progress: number) => void,
  options?: MasterExportOptions
): Promise<void> {
  try {
    const mode = options?.mode || 'master-video';
    const quality = options?.quality || 'balanced';
    const outputFormat = options?.outputFormat || 'webm';

    // 1. Collect completed shots that already have video output.
    const completedShots = project.shots.filter(shot => shot.interval?.videoUrl);
    
    if (completedShots.length === 0) {
      throw new Error('No video segments available for export');
    }

    if (mode === 'segments-zip') {
      await downloadMasterVideoAsZip(project, completedShots, onProgress);
      onProgress?.('Completed (segments ZIP)', 100);
      return;
    }

    onProgress?.('Downloading video segments...', 5);
    const videoBlobs: Blob[] = [];
    for (let i = 0; i < completedShots.length; i++) {
      const shot = completedShots[i];
      const videoUrl = shot.interval!.videoUrl!;
      const videoBlob = await downloadFile(videoUrl);
      videoBlobs.push(videoBlob);

      const progress = 5 + Math.round(((i + 1) / completedShots.length) * 40);
      onProgress?.(`Downloading (${i + 1}/${completedShots.length})...`, progress);
    }

    if (!canStitchMasterVideo()) {
      await downloadMasterVideoAsZip(project, completedShots, onProgress);
      onProgress?.('Completed (exported segments ZIP)', 100);
      return;
    }

    try {
      const stitched = await stitchVideoBlobsToMaster(videoBlobs, quality, onProgress);
      
      let finalBlob = stitched.blob;
      let finalExtension = stitched.extension;
      
      // Convert to MP4 if requested
      if (outputFormat === 'mp4') {
        try {
          console.log('[Export] Starting MP4 conversion...');
          // Create a progress wrapper that maps conversion progress to 92-98 range
          const conversionProgress = (phase: string, prog: number) => {
            // Map 0-100 to 92-98
            const mappedProgress = 92 + Math.round(prog * 0.06);
            onProgress?.(phase, mappedProgress);
          };
          finalBlob = await convertWebMToMP4(stitched.blob, quality, conversionProgress);
          finalExtension = 'mp4';
          console.log('[Export] MP4 conversion successful');
        } catch (conversionError) {
          console.warn('[Export] MP4 conversion failed:', conversionError);
          // Show user-friendly error message
          const errorMsg = conversionError instanceof Error ? conversionError.message : '未知错误';
          console.error('[Export] Error details:', errorMsg);
          // Notify user via progress callback
          onProgress?.(`MP4 转换失败，使用 WebM 格式: ${errorMsg}`, 92);
          // Wait a bit so user can see the message
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Keep the original WebM format
        }
      }
      
      onProgress?.('准备下载...', 99);

      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${createProjectTitle(project)}_master.${finalExtension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      onProgress?.('完成！', 100);
    } catch (stitchError) {
      console.warn('Master stitch failed, fallback to segments ZIP export:', stitchError);
      await downloadMasterVideoAsZip(project, completedShots, onProgress);
      onProgress?.('Completed (exported segments ZIP)', 100);
    }
  } catch (error) {
    console.error('Master export failed:', error);
    throw error;
  }
}

/**
 * Estimate total duration of all shots in seconds.
 * Falls back to 10 seconds when shot duration is missing.
 */
export function estimateTotalDuration(project: ProjectState): number {
  return project.shots.reduce((acc, shot) => {
    return acc + (shot.interval?.duration || 10);
  }, 0);
}

/**
 * Package source assets (character/scene/keyframe/video files) into ZIP.
 */
export async function downloadSourceAssets(
  project: ProjectState,
  onProgress?: (phase: string, progress: number) => void
): Promise<void> {
  try {
    // Lazy-load JSZip.
    onProgress?.('Loading ZIP library...', 0);
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();

    // Collect all downloadable assets.
    const assets: { url: string; path: string }[] = [];

    // 1. Character reference images.
    if (project.scriptData?.characters) {
      for (const char of project.scriptData.characters) {
        if (char.referenceImage) {
          assets.push({
            url: char.referenceImage,
            path: `characters/${char.name.replace(/[\/\\?%*:|"<>]/g, '_')}_base.jpg`
          });
        }
        // Character variation images.
        if (char.variations) {
          for (const variation of char.variations) {
            if (variation.referenceImage) {
              assets.push({
                url: variation.referenceImage,
                path: `characters/${char.name.replace(/[\/\\?%*:|"<>]/g, '_')}_${variation.name.replace(/[\/\\?%*:|"<>]/g, '_')}.jpg`
              });
            }
          }
        }
      }
    }

    // 2. Scene reference images.
    if (project.scriptData?.scenes) {
      for (const scene of project.scriptData.scenes) {
        if (scene.referenceImage) {
          assets.push({
            url: scene.referenceImage,
            path: `scenes/${scene.location.replace(/[\/\\?%*:|"<>]/g, '_')}.jpg`
          });
        }
      }
    }

    // 3. Shot keyframe images.
    if (project.shots) {
      for (let i = 0; i < project.shots.length; i++) {
        const shot = project.shots[i];
        const shotNum = String(i + 1).padStart(3, '0');
        
        if (shot.keyframes) {
          for (const keyframe of shot.keyframes) {
            if (keyframe.imageUrl) {
              assets.push({
                url: keyframe.imageUrl,
                path: `shots/shot_${shotNum}_${keyframe.type}_frame.jpg`
              });
            }
          }
        }

        // 4. Shot video segments.
        if (shot.interval?.videoUrl) {
          assets.push({
            url: shot.interval.videoUrl,
            path: `videos/shot_${shotNum}.mp4`
          });
        }

        // 5. Shot dubbing audio.
        if (shot.dubbing?.audioUrl) {
          const audioExt = inferDubbingExtension(shot);
          assets.push({
            url: shot.dubbing.audioUrl,
            path: `dubbing/shot_${shotNum}.${audioExt}`
          });
        }
      }
    }

    if (assets.length === 0) {
      throw new Error('No downloadable assets found');
    }

    onProgress?.('Downloading assets...', 5);

    // Download assets and add them to ZIP.
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      try {
        const blob = await downloadFile(asset.url);
        zip.file(asset.path, blob);
        
        const progress = 5 + Math.round((i + 1) / assets.length * 80);
        onProgress?.(`Downloading (${i + 1}/${assets.length})...`, progress);
      } catch (error) {
        console.error(`Failed to download asset: ${asset.path}`, error);
        // Continue with remaining files instead of aborting the whole export.
      }
    }

    onProgress?.('Generating ZIP file...', 90);

    // Build ZIP blob.
    const zipBlob = await zip.generateAsync(
      { type: 'blob' },
      (metadata) => {
        const progress = 90 + Math.round(metadata.percent / 10);
        onProgress?.('Compressing...', progress);
      }
    );

    // Trigger browser download.
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.scriptData?.title || project.title || 'project'}_source_assets.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    onProgress?.('Completed!', 100);
  } catch (error) {
    console.error('Source assets download failed:', error);
    throw error;
  }
}
