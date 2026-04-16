import type { CapabilityTask, PlanState } from '@bridge/ipc/contracts';
import { formatTimestamp } from '@renderer/lib/format';

interface PlanDrawerProps {
  open: boolean;
  planState: PlanState | null;
  tasks: CapabilityTask[];
  onClose?: (() => void) | undefined;
  onDeleteTask?: ((taskId: string) => void) | undefined;
}

function statusBadgeClass(status: CapabilityTask['status']) {
  switch (status) {
    case 'in_progress':
      return 'bg-cyan-400/15 text-cyan-100';
    case 'completed':
      return 'bg-emerald-400/15 text-emerald-200';
    case 'failed':
      return 'bg-rose-400/15 text-rose-200';
    case 'cancelled':
      return 'bg-amber-400/15 text-amber-200';
    default:
      return 'bg-slate-400/15 text-slate-300';
  }
}

function statusLabel(status: CapabilityTask['status']) {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending';
  }
}

function TaskRow(props: { task: CapabilityTask; onDelete?: (() => void) | undefined }) {
  const { task, onDelete } = props;
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs font-mono text-slate-500">#{task.sequence}</span>
          <p className="min-w-0 text-sm font-medium leading-6 text-slate-100">{task.title}</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${statusBadgeClass(task.status)}`}
        >
          {statusLabel(task.status)}
        </span>
      </div>
      {task.details ? (
        <p className="mt-1.5 text-xs leading-5 text-slate-400">{task.details}</p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-slate-500">{formatTimestamp(task.createdAt)}</p>
        {onDelete ? (
          <button
            aria-label="Delete task"
            className="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-rose-300 transition hover:bg-rose-400/10 hover:text-rose-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
            onClick={onDelete}
            type="button"
          >
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TaskGroup(props: {
  title: string;
  tasks: CapabilityTask[];
  emptyText: string;
  onDeleteTask?: ((taskId: string) => void) | undefined;
}) {
  return (
    <section className="space-y-3 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">{props.title}</h3>
        <span className="text-xs text-slate-400">{props.tasks.length}</span>
      </div>
      {props.tasks.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
          {props.emptyText}
        </p>
      ) : (
        <div className="space-y-2">
          {props.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onDelete={props.onDeleteTask ? () => props.onDeleteTask?.(task.id) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function PlanDrawer(props: PlanDrawerProps) {
  if (!props.open) {
    return null;
  }

  const activeTasks = props.tasks.filter((t) => t.status === 'in_progress');
  const pendingTasks = props.tasks.filter((t) => t.status === 'pending');
  const doneTasks = props.tasks.filter(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );
  const planActive = props.planState?.status === 'active';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6 animate-fade-in">
      <section className="pointer-events-auto flex max-h-[calc(70vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur animate-slide-in-up">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Plan mode</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Tasks</h2>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                  planActive
                    ? 'bg-cyan-400/15 text-cyan-100'
                    : 'bg-slate-400/15 text-slate-400'
                }`}
              >
                Plan mode {planActive ? 'active' : 'inactive'}
              </span>
              {props.planState?.summary ? (
                <p className="text-sm text-slate-400">{props.planState.summary}</p>
              ) : null}
            </div>
          </div>
          {props.onClose ? (
            <button
              aria-label="Close plan drawer"
              className="mt-1 shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={props.onClose}
              type="button"
            >
              Close
            </button>
          ) : null}
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <div className="grid gap-5 lg:grid-cols-3">
            <TaskGroup
              emptyText="No tasks in progress."
              onDeleteTask={props.onDeleteTask}
              tasks={activeTasks}
              title="In progress"
            />
            <TaskGroup
              emptyText="No pending tasks."
              onDeleteTask={props.onDeleteTask}
              tasks={pendingTasks}
              title="Pending"
            />
            <TaskGroup
              emptyText="No completed tasks yet."
              onDeleteTask={props.onDeleteTask}
              tasks={doneTasks}
              title="Completed / done"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
