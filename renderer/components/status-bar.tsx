import type { SystemStatus } from '@bridge/ipc/contracts';

interface StatusBarProps {
  systemStatus: SystemStatus | null;
  queueOpen?: boolean;
  planOpen?: boolean;
  onOpenQueue: () => void;
  onOpenPlan: () => void;
}

function getTextBackendHealth(systemStatus: SystemStatus | null) {
  if (!systemStatus) {
    return {
      label: 'Ollama',
      healthy: false,
      detail: 'checking'
    };
  }

  if (systemStatus.activeTextBackend === 'nvidia') {
    return {
      label: 'NVIDIA',
      healthy: systemStatus.nvidia.configured,
      detail: systemStatus.nvidia.configured
        ? `${systemStatus.nvidia.models.length} preset(s)`
        : systemStatus.nvidia.error ?? 'missing API key'
    };
  }

  return {
    label: 'Ollama',
    healthy: systemStatus.ollama.reachable,
    detail: systemStatus.ollama.reachable
      ? `${systemStatus.ollama.models.length} model(s)`
      : systemStatus.ollama.error ?? 'checking'
  };
}

function formatVramDetail(systemStatus: SystemStatus | null) {
  const vram = systemStatus?.python.vram;

  if (!systemStatus?.python.reachable) {
    return systemStatus?.python.error ?? 'checking';
  }

  if (!vram) {
    return 'state unavailable';
  }

  if (!vram.cudaAvailable || vram.totalMb === null || vram.freeMb === null) {
    return 'CPU worker';
  }

  const usedMb = Math.max(0, vram.totalMb - vram.freeMb);
  const usedDisplay = Math.round(usedMb);
  const totalDisplay = Math.round(vram.totalMb);
  return `${usedDisplay} / ${totalDisplay} MiB`;
}

function formatPythonDetail(systemStatus: SystemStatus | null) {
  if (!systemStatus?.python.reachable) {
    return systemStatus?.python.error ?? 'checking';
  }

  const modelManager = systemStatus.python.modelManager;
  const loadedModel = modelManager?.loadedModel;
  const backend = modelManager?.loadedBackend;

  if (loadedModel && backend) {
    return `${backend} · ${loadedModel}`;
  }

  return `pid ${systemStatus.python.pid ?? 'n/a'}`;
}

function ConnectionPill(props: { label: string; healthy: boolean; detail: string }) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors duration-150 ${
        props.healthy
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100'
          : 'border-rose-400/30 bg-rose-400/10 text-rose-100'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${
          props.healthy ? 'bg-emerald-300' : 'bg-rose-300'
        }`}
      />
      <span className="font-medium">{props.label}</span>
      <span className="text-[11px] opacity-80 hidden sm:inline">{props.detail}</span>
    </div>
  );
}

export function StatusBar(props: StatusBarProps) {
  const textBackend = getTextBackendHealth(props.systemStatus);
  const activeButtonClass = 'border-cyan-300/30 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/20';
  const idleButtonClass = 'border-white/10 text-slate-200 hover:border-white/20 hover:bg-white/5';

  return (
    <footer className="flex items-center justify-between gap-4 border-t border-white/10 bg-slate-950/90 px-5 py-3 text-sm text-slate-300 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionPill
          detail={textBackend.detail}
          healthy={textBackend.healthy}
          label={textBackend.label}
        />
        <ConnectionPill
          detail={formatPythonDetail(props.systemStatus)}
          healthy={props.systemStatus?.python.reachable ?? false}
          label="Python"
        />
        <ConnectionPill
          detail={formatVramDetail(props.systemStatus)}
          healthy={props.systemStatus?.python.reachable ?? false}
          label="VRAM"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.planOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenPlan}
          type="button"
        >
          Plan
        </button>
        <button
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.queueOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenQueue}
          type="button"
        >
          Queue
        </button>
      </div>
    </footer>
  );
}
