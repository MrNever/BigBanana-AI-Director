import React from 'react';
import { Play, Download, FileVideo, Loader2 } from 'lucide-react';
import { DownloadState } from './constants';
import { useAlert } from '../GlobalAlert';
import { MasterExportMode, MasterVideoQuality, MasterVideoOutputFormat } from '../../services/exportService';

interface Props {
  completedShotsCount: number;
  totalShots: number;
  progress: number;
  downloadState: DownloadState;
  exportMode: MasterExportMode;
  exportQuality: MasterVideoQuality;
  outputFormat: MasterVideoOutputFormat;
  onExportModeChange: (mode: MasterExportMode) => void;
  onExportQualityChange: (quality: MasterVideoQuality) => void;
  onOutputFormatChange: (format: MasterVideoOutputFormat) => void;
  onPreview: () => void;
  onDownloadMaster: () => void;
}

const ActionButtons: React.FC<Props> = ({
  completedShotsCount,
  totalShots,
  progress,
  downloadState,
  exportMode,
  exportQuality,
  outputFormat,
  onExportModeChange,
  onExportQualityChange,
  onOutputFormatChange,
  onPreview,
  onDownloadMaster
}) => {
  const { showAlert } = useAlert();
  const { isDownloading, phase, progress: downloadProgress } = downloadState;
  const canDownloadMaster = progress === 100;
  const canDownloadSegments = completedShotsCount > 0;
  const canDownloadByMode = exportMode === 'segments-zip' ? canDownloadSegments : canDownloadMaster;

  const formatLabel = outputFormat === 'mp4' ? 'MP4' : 'WEBM';
  const modeLabel = exportMode === 'segments-zip' ? '下载分镜片段 ZIP' : `下载母版视频（${formatLabel}）`;
  const cardBase = 'min-h-[156px] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-surface)] p-4 flex flex-col justify-between shadow-sm';
  const titleClass = 'text-xs font-bold text-[var(--text-primary)] uppercase tracking-wider';
  const descClass = 'text-[10px] leading-relaxed text-[var(--text-tertiary)]';
  const ghostActionClass = 'h-10 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-secondary)] hover:text-[var(--text-primary)] transition-colors text-xs font-semibold flex items-center justify-center gap-2';
  const disabledActionClass = 'h-10 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-elevated)] text-[var(--text-muted)] cursor-not-allowed text-xs font-semibold flex items-center justify-center gap-2';
  const primaryActionClass = 'h-10 rounded-lg border border-[var(--accent-border)] bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] transition-colors text-xs font-bold flex items-center justify-center gap-2';
  const darkActionClass = 'h-10 rounded-lg border border-black/20 bg-black text-white hover:bg-black/90 transition-colors text-xs font-bold flex items-center justify-center gap-2';
  const loadingActionClass = 'h-10 rounded-lg border border-[var(--accent-border)] bg-[var(--accent)] text-[var(--accent-text)] cursor-wait text-xs font-bold flex items-center justify-center gap-2';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
      <div className={cardBase}>
        <div className="space-y-1.5">
          <p className={titleClass}>预览校验</p>
          <p className={descClass}>快速检查镜头顺序与生成完整度，避免导出后再返工。</p>
        </div>
        <button
          onClick={onPreview}
          disabled={completedShotsCount === 0}
          className={
            completedShotsCount > 0 ? primaryActionClass : disabledActionClass
          }
        >
          <Play className="w-4 h-4" />
          预览视频 ({completedShotsCount}/{totalShots})
        </button>
      </div>

      <div className={cardBase}>
        <div className="space-y-2">
          <p className={titleClass}>导出设置</p>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={exportMode}
              onChange={(event) => onExportModeChange(event.target.value as MasterExportMode)}
              disabled={isDownloading}
              className="h-8 bg-[var(--bg-elevated)] border border-[var(--border-primary)] text-[var(--text-secondary)] rounded px-2 text-[11px] focus:outline-none"
            >
              <option value="master-video">母版拼接</option>
              <option value="segments-zip">分镜ZIP</option>
            </select>
            {exportMode === 'master-video' ? (
              <select
                value={exportQuality}
                onChange={(event) => onExportQualityChange(event.target.value as MasterVideoQuality)}
                disabled={isDownloading}
                className="h-8 bg-[var(--bg-elevated)] border border-[var(--border-primary)] text-[var(--text-secondary)] rounded px-2 text-[11px] focus:outline-none"
              >
                <option value="economy">省流</option>
                <option value="balanced">均衡</option>
                <option value="pro">高画质</option>
              </select>
            ) : (
              <div className="h-8 rounded border border-transparent bg-transparent" aria-hidden="true" />
            )}
          </div>
          {exportMode === 'master-video' && (
            <div className="grid grid-cols-2 gap-2">
              <select
                value={outputFormat}
                onChange={(event) => onOutputFormatChange(event.target.value as MasterVideoOutputFormat)}
                disabled={isDownloading}
                className="h-8 bg-[var(--bg-elevated)] border border-[var(--border-primary)] text-[var(--text-secondary)] rounded px-2 text-[11px] focus:outline-none"
              >
                <option value="webm">WebM 格式</option>
                <option value="mp4">MP4 格式</option>
              </select>
              <div className="h-8 rounded border border-transparent bg-transparent" aria-hidden="true" />
            </div>
          )}
          <p className={descClass}>
            {exportMode === 'segments-zip'
              ? '分镜ZIP适合自己在剪辑软件二次创作。'
              : `母版拼接适合快速交付，质量档位会影响文件体积。${outputFormat === 'mp4' ? 'MP4格式兼容性更好。' : 'WebM体积更小。'}`}
          </p>
        </div>
        <button
          onClick={onDownloadMaster}
          disabled={!canDownloadByMode || isDownloading}
          className={
            isDownloading
              ? loadingActionClass
              : canDownloadByMode
                ? darkActionClass
                : disabledActionClass
          }
        >
          {isDownloading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          {isDownloading ? `${phase} ${downloadProgress}%` : modeLabel}
        </button>
      </div>

      <div className={cardBase}>
        <div className="space-y-1.5">
          <p className={titleClass}>剪辑工程</p>
          <p className={descClass}>导出 NLE 工程模板（PR/FCP/达芬奇）用于协同制作。</p>
        </div>
        <button
          className={ghostActionClass}
          onClick={() => showAlert('暂未开发', { type: 'info', title: '提示' })}
        >
          <FileVideo className="w-4 h-4" />
          导出剪辑工程文件
        </button>
      </div>
    </div>
  );
};

export default ActionButtons;
