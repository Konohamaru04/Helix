import { useEffect, useMemo, useState } from 'react';
import type { GenerationJob } from '@bridge/ipc/contracts';
import { formatTimestamp } from '@renderer/lib/format';
import {
  isPreviewableImagePath,
  isPreviewableVideoPath,
  loadPreviewUrl,
  openLocalPreviewPath
} from '@renderer/lib/attachments';
import { InlineVideoPlayer } from '@renderer/components/inline-video-player';

interface GenerationJobCardProps {
  job: GenerationJob;
  compact?: boolean;
  onCancel?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
  showPrompt?: boolean;
}

function formatStatus(status: GenerationJob['status']) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Completed';
  }
}

export function GenerationJobCard(props: GenerationJobCardProps) {
  const showPrompt = props.showPrompt ?? true;
  const artifact = props.job.artifacts[0] ?? null;
  const artifactKindLabel = artifact?.kind === 'video' ? 'video' : 'image';
  const imagePreviewable =
    artifact?.kind === 'image' &&
    isPreviewableImagePath(artifact.filePath, artifact.mimeType, artifact.filePath);
  const videoPreviewable =
    artifact?.kind === 'video' &&
    isPreviewableVideoPath(artifact.filePath, artifact.mimeType, artifact.filePath);
  const previewSourcePath =
    artifact && imagePreviewable
      ? artifact.previewPath ?? artifact.filePath
      : artifact && videoPreviewable
        ? artifact.filePath
        : null;
  const [previewState, setPreviewState] = useState<{
    sourcePath: string;
    url: string | null;
  } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    if (!previewSourcePath) {
      return () => {
        active = false;
      };
    }

    void loadPreviewUrl(previewSourcePath).then((resolvedPreviewUrl) => {
      if (!active) {
        return;
      }

      setPreviewState({
        sourcePath: previewSourcePath,
        url: resolvedPreviewUrl
      });
    });

    return () => {
      active = false;
    };
  }, [previewSourcePath]);

  const previewUrl =
    previewSourcePath && previewState?.sourcePath === previewSourcePath
      ? previewState.url
      : null;
  const previewResolved =
    previewSourcePath === null || previewState?.sourcePath === previewSourcePath;
  const previewable = previewSourcePath !== null;

  const progressLabel = useMemo(
    () => `${Math.round(props.job.progress * 100)}%`,
    [props.job.progress]
  );
  const canCancel = props.job.status === 'queued' || props.job.status === 'running';
  const canRetry = props.job.status === 'failed' || props.job.status === 'cancelled';

  async function handleOpenArtifact() {
    if (!artifact?.filePath) {
      return;
    }

    try {
      setOpenError(null);
      await openLocalPreviewPath(artifact.filePath);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : 'Unable to open the generated output.'
      );
    }
  }

  return (
      <article className="motion-card motion-panel overflow-hidden rounded-[1.5rem] border border-white/10 bg-slate-900/80 shadow-panel">
        {previewable && videoPreviewable ? (
          <div className="m-4 mb-0 block overflow-hidden rounded-[1.25rem] border border-white/10 bg-slate-950" style={{ maxWidth: `${props.compact ? 288 : 420}px` }}>
            <div
              className="relative flex items-center justify-center overflow-hidden bg-slate-950"
              style={{
                aspectRatio:
                  props.job.width > 0 && props.job.height > 0
                    ? `${props.job.width} / ${props.job.height}`
                    : '16 / 9'
              }}
            >
              {previewUrl ? (
                <InlineVideoPlayer
                  src={previewUrl}
                  ariaLabel={props.job.prompt}
                  className="motion-panel"
                />
              ) : (
                <div className="motion-loader-sweep flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-500">
                  {previewResolved ? 'Preview unavailable' : 'Loading video...'}
                </div>
              )}
            </div>
          </div>
        ) : previewable ? (
          <button
            aria-label={`Open generated ${artifactKindLabel}`}
            className="motion-interactive m-4 mb-0 block max-w-3xl overflow-hidden rounded-[1.25rem] border border-white/10 bg-slate-950 text-left transition hover:border-cyan-300/30 hover:bg-slate-950/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            onClick={() => {
              void handleOpenArtifact();
            }}
            type="button"
          >
            <div
              className={`flex items-center justify-center overflow-hidden bg-slate-950 ${
                props.compact ? 'max-h-56 min-h-40' : 'max-h-[26rem] min-h-52'
              }`}
            >
              {previewUrl ? (
                <img
                  alt={props.job.prompt}
                  className={`motion-panel w-full object-contain ${
                    props.compact ? 'max-h-56' : 'max-h-[26rem]'
                  }`}
                  loading="lazy"
                  src={previewUrl}
                />
              ) : (
                <div className="motion-loader-sweep flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-500">
                  {previewResolved ? 'Preview unavailable' : 'Loading preview...'}
                </div>
              )}
            </div>
          </button>
        ) : null}

        <div className="space-y-3 px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/70">
              {props.job.kind === 'video' ? 'Video job' : 'Image job'}
            </p>
            {showPrompt ? (
              <p className="mt-2 line-clamp-3 text-sm font-medium leading-6 text-slate-100">
                {props.job.prompt}
              </p>
            ) : null}
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${
              props.job.status === 'completed'
                ? 'bg-emerald-400/15 text-emerald-200'
                : props.job.status === 'failed'
                  ? 'bg-rose-400/15 text-rose-200'
                  : props.job.status === 'cancelled'
                    ? 'bg-amber-400/15 text-amber-200'
                    : 'bg-cyan-400/15 text-cyan-100'
            }`}
          >
            {formatStatus(props.job.status)}
          </span>
        </div>

        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className={`motion-progress-bar h-full rounded-full ${
                props.job.status === 'failed'
                  ? 'bg-rose-300'
                  : props.job.status === 'cancelled'
                    ? 'bg-amber-300'
                    : 'bg-cyan-300'
              }`}
              style={{ width: `${Math.max(4, props.job.progress * 100)}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>{props.job.stage ?? 'Waiting for updates'}</span>
            <span>{progressLabel}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-slate-400">
          <span>{props.job.model}</span>
          <span>
            {props.job.width} x {props.job.height}
          </span>
          <span>{props.job.steps} steps</span>
          {props.job.frameCount ? <span>{props.job.frameCount} frames</span> : null}
          {props.job.frameRate ? <span>{props.job.frameRate} fps</span> : null}
          <span>{formatTimestamp(props.job.createdAt)}</span>
        </div>

        {props.job.errorMessage ? (
          <p className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs leading-6 text-rose-100">
            {props.job.errorMessage}
          </p>
        ) : null}

        {artifact ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <span>
              {artifact.kind === 'video'
                ? videoPreviewable && previewUrl
                  ? 'Playing inline. Use the player controls above.'
                  : 'Open the local clip to review it.'
                : 'Click preview to open'}
            </span>
            {openError ? <span className="text-rose-200">{openError}</span> : null}
          </div>
        ) : null}

        {artifact ? (
          <div className="space-y-2">
            <p className="break-all text-[11px] text-slate-500">{artifact.filePath}</p>
            <button
              className="motion-interactive rounded-xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              onClick={() => {
                void handleOpenArtifact();
              }}
              type="button"
            >
              Open generated {artifactKindLabel}
            </button>
          </div>
        ) : null}

        {((canCancel && props.onCancel) || (canRetry && props.onRetry)) ? (
          <div className="flex flex-wrap gap-3">
            {canCancel && props.onCancel ? (
              <button
                className="motion-interactive rounded-xl border border-rose-300/20 px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-300/30 hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                onClick={() => props.onCancel?.(props.job.id)}
                type="button"
              >
                Cancel job
              </button>
            ) : null}
            {canRetry && props.onRetry ? (
              <button
                className="motion-interactive rounded-xl border border-cyan-300/20 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/30 hover:bg-cyan-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                onClick={() => props.onRetry?.(props.job.id)}
                type="button"
              >
                Retry job
              </button>
            ) : null}
          </div>
        ) : null}
        </div>
      </article>
  );
}
