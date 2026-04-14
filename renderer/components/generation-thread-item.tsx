import type { GenerationJob } from '@bridge/ipc/contracts';
import { AttachmentCard } from '@renderer/components/attachment-card';
import { GenerationJobCard } from '@renderer/components/generation-job-card';
import { formatTimestamp } from '@renderer/lib/format';

interface GenerationThreadItemProps {
  job: GenerationJob;
  onCancel?: (jobId: string) => void;
  onRetry?: (jobId: string) => void;
}

function formatGenerationMode(mode: GenerationJob['mode']) {
  return mode === 'image-to-image' ? 'Image edit' : 'Image request';
}

export function GenerationThreadItem(props: GenerationThreadItemProps) {
  return (
    <div className="space-y-3">
      <article className="ml-3 min-w-0 overflow-hidden rounded-[1.75rem] border border-orange-300/20 bg-orange-500/10 px-5 py-4 text-orange-50 shadow-panel">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">user</p>
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200">
                {formatGenerationMode(props.job.mode)}
              </span>
            </div>

            {props.job.referenceImages.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {props.job.referenceImages.map((attachment) => (
                  <AttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                  />
                ))}
              </div>
            ) : null}

            <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{props.job.prompt}</p>
          </div>

          <div className="shrink-0 text-right text-xs text-slate-500">
            <p>{formatTimestamp(props.job.createdAt)}</p>
            <p className="mt-1">submitted</p>
          </div>
        </div>
      </article>

      <div className="min-w-0 overflow-hidden rounded-[1.75rem] border border-cyan-300/20 bg-slate-900/80 px-5 py-4 text-slate-100 shadow-panel">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                assistant
              </p>
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200">
                Image generation
              </span>
            </div>

            <div className="mt-3">
              <GenerationJobCard
                job={props.job}
                showPrompt={false}
                {...(props.onCancel ? { onCancel: props.onCancel } : {})}
                {...(props.onRetry ? { onRetry: props.onRetry } : {})}
              />
            </div>
          </div>

          <div className="shrink-0 text-right text-xs text-slate-500">
            <p>{formatTimestamp(props.job.updatedAt)}</p>
            <p className="mt-1 capitalize">{props.job.status}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
