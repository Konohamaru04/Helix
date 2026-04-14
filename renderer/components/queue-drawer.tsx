import type { GenerationJob } from '@bridge/ipc/contracts';
import { GenerationJobCard } from '@renderer/components/generation-job-card';

interface QueueDrawerProps {
  open: boolean;
  pendingRequestCount: number;
  generationJobs: GenerationJob[];
  onCancelGenerationJob?: (jobId: string) => void;
  onRetryGenerationJob?: (jobId: string) => void;
}

export function QueueDrawer(props: QueueDrawerProps) {
  if (!props.open) {
    return null;
  }

  const queuedJobs = props.generationJobs.filter(
    (job) => job.status === 'queued' || job.status === 'running'
  );
  const completedJobs = props.generationJobs.filter((job) => job.status === 'completed');
  const failedJobs = props.generationJobs.filter(
    (job) => job.status === 'failed' || job.status === 'cancelled'
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6">
      <section className="pointer-events-auto w-full max-w-6xl rounded-[2rem] border border-white/10 bg-slate-950/95 px-6 py-5 shadow-2xl backdrop-blur">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Queue</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Execution status</h2>
        <p className="mt-3 text-sm leading-7 text-slate-300">
          Pending chat requests: {props.pendingRequestCount}. Image generation now stays inline in
          the chat transcript, while this drawer remains the global queue and recovery view.
        </p>

        <div className="mt-5 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
          <section className="space-y-3 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-100">Active image jobs</h3>
              <span className="text-xs text-slate-400">{queuedJobs.length}</span>
            </div>
            {queuedJobs.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                No active image jobs right now.
              </p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {queuedJobs.map((job) => (
                  <GenerationJobCard
                    key={job.id}
                    job={job}
                    {...(props.onCancelGenerationJob
                      ? { onCancel: props.onCancelGenerationJob }
                      : {})}
                    {...(props.onRetryGenerationJob
                      ? { onRetry: props.onRetryGenerationJob }
                      : {})}
                  />
                ))}
              </div>
            )}
          </section>

          <div className="space-y-5">
            <section className="space-y-3 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-100">Completed</h3>
                <span className="text-xs text-slate-400">{completedJobs.length}</span>
              </div>
              {completedJobs.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                  Completed images will appear here.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {completedJobs.slice(0, 4).map((job) => (
                    <GenerationJobCard
                      key={job.id}
                      compact
                      job={job}
                      {...(props.onRetryGenerationJob
                        ? { onRetry: props.onRetryGenerationJob }
                        : {})}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-100">Recent issues</h3>
                <span className="text-xs text-slate-400">{failedJobs.length}</span>
              </div>
              {failedJobs.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                  No recent failed or cancelled generation jobs.
                </p>
              ) : (
                <div className="space-y-3">
                  {failedJobs.slice(0, 3).map((job) => (
                    <GenerationJobCard
                      key={job.id}
                      job={job}
                      {...(props.onRetryGenerationJob
                        ? { onRetry: props.onRetryGenerationJob }
                        : {})}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
