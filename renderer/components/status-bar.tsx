import type { SystemStatus } from '@bridge/ipc/contracts';
import { ThemedSelect } from '@renderer/components/themed-select';

interface StatusBarProps {
  systemStatus: SystemStatus | null;
  queueOpen?: boolean;
  planOpen?: boolean;
  agentsOpen?: boolean;
  skillsOpen?: boolean;
  onOpenQueue: () => void;
  onOpenPlan: () => void;
  onOpenAgents: () => void;
  onOpenSkills: () => void;
  onOpenSettings: () => void;
  activeTextBackend: 'ollama' | 'nvidia';
  onTextBackendChange: (backend: 'ollama' | 'nvidia') => void;
  selectedModel: string;
  availableModels: string[];
  onSelectedModelChange: (model: string) => void;
  selectedThinkMode: string;
  onSelectedThinkModeChange: (thinkMode: string) => void;
  thinkModeDisabled?: boolean;
  settingsOpen?: boolean;
}

const THINK_MODE_OPTIONS = [
  { value: '', label: 'Think auto' },
  { value: 'off', label: 'Think off' },
  { value: 'on', label: 'Think on' },
  { value: 'low', label: 'Think low' },
  { value: 'medium', label: 'Think medium' },
  { value: 'high', label: 'Think high' }
] as const;

function getOllamaHealth(systemStatus: SystemStatus | null) {
  if (!systemStatus) {
    return {
      label: 'Ollama',
      healthy: false,
      detail: 'checking'
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

function getNvidiaHealth(systemStatus: SystemStatus | null) {
  if (!systemStatus) {
    return {
      label: 'NVIDIA',
      healthy: false,
      detail: 'checking'
    };
  }

  return {
    label: 'NVIDIA',
    healthy: systemStatus.nvidia.configured,
    detail: systemStatus.nvidia.configured
      ? `${systemStatus.nvidia.models.length} preset(s)`
      : systemStatus.nvidia.error ?? 'missing API key'
  };
}

function getPythonFailure(systemStatus: SystemStatus | null) {
  if (!systemStatus || systemStatus.python.reachable) {
    return null;
  }

  return {
    label: 'Python',
    healthy: false,
    detail: systemStatus.python.error ?? 'offline'
  };
}

function ConnectionPill(props: {
  label: string;
  healthy: boolean;
  detail: string;
}) {
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
      <span className="hidden text-[11px] opacity-80 sm:inline">{props.detail}</span>
    </div>
  );
}

export function StatusBar(props: StatusBarProps) {
  const ollamaHealth = getOllamaHealth(props.systemStatus);
  const nvidiaHealth = getNvidiaHealth(props.systemStatus);
  const pythonFailure = getPythonFailure(props.systemStatus);
  const activeButtonClass = 'border-cyan-300/30 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/20';
  const idleButtonClass = 'border-white/10 text-slate-200 hover:border-white/20 hover:bg-white/5';
  const modelOptions = Array.from(
    new Set([props.selectedModel, ...props.availableModels].filter(Boolean))
  );

  return (
    <footer
      className="motion-panel flex items-center justify-between gap-4 border-t border-white/10 bg-slate-950/90 px-5 py-3 text-sm text-slate-300 backdrop-blur"
      data-mascot-target="status-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionPill
          detail={ollamaHealth.detail}
          healthy={ollamaHealth.healthy}
          label={ollamaHealth.label}
        />
        <ConnectionPill
          detail={nvidiaHealth.detail}
          healthy={nvidiaHealth.healthy}
          label={nvidiaHealth.label}
        />
        {pythonFailure ? (
          <ConnectionPill
            detail={pythonFailure.detail}
            healthy={pythonFailure.healthy}
            label={pythonFailure.label}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <ThemedSelect
          ariaLabel="Text backend"
          onChange={(value) => props.onTextBackendChange(value as 'ollama' | 'nvidia')}
          options={[
            { value: 'ollama', label: 'Ollama' },
            { value: 'nvidia', label: 'NVIDIA' }
          ]}
          placement="top"
          size="compact"
          value={props.activeTextBackend}
        />

        <ThemedSelect
          ariaLabel="Model"
          onChange={props.onSelectedModelChange}
          options={[
            { value: '', label: 'Auto' },
            ...modelOptions.map((model) => ({
              value: model,
              label: model
            }))
          ]}
          placement="top"
          size="compact"
          value={props.selectedModel}
        />

        <ThemedSelect
          ariaLabel="Think mode"
          disabled={props.thinkModeDisabled}
          onChange={props.onSelectedThinkModeChange}
          options={THINK_MODE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label
          }))}
          placement="top"
          size="compact"
          value={props.selectedThinkMode}
        />

        <button
          className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.settingsOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenSettings}
          type="button"
        >
          Settings
        </button>
        <button
          className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.planOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenPlan}
          type="button"
        >
          Plan
        </button>
        <button
          className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.agentsOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenAgents}
          type="button"
        >
          Agents
        </button>
        <button
          className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.skillsOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenSkills}
          type="button"
        >
          Skills
        </button>
        <button
          className={`motion-interactive rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${props.queueOpen ? activeButtonClass : idleButtonClass}`}
          onClick={props.onOpenQueue}
          type="button"
        >
          Queue
        </button>
      </div>
    </footer>
  );
}
