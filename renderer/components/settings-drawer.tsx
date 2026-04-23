import { Children, isValidElement, type ReactNode, useEffect, useState } from 'react';
import type {
  AgentSession,
  AuditEventRecord,
  CapabilityPermission,
  CapabilityTask,
  ImageGenerationModelCatalog,
  PlanState,
  ScheduledPrompt,
  TeamSession,
  ToolDefinition,
  UpdateUserSettings,
  UserSettings,
  WorktreeSession
} from '@bridge/ipc/contracts';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import {
  getImageGenerationModelOptions,
  getVideoGenerationHighNoiseModelOptions,
  getVideoGenerationLowNoiseModelOptions
} from '@renderer/lib/image-generation-models';
import { ThemedSelect, type ThemedSelectOption } from '@renderer/components/themed-select';

interface SettingsDrawerProps {
  open: boolean;
  settings: UserSettings | null;
  ollamaModels: string[];
  nvidiaModels: string[];
  capabilities: ToolDefinition[];
  capabilityPermissions: CapabilityPermission[];
  capabilityTasks: CapabilityTask[];
  capabilitySchedules: ScheduledPrompt[];
  capabilityAgents: AgentSession[];
  capabilityTeams: TeamSession[];
  capabilityWorktrees: WorktreeSession[];
  capabilityPlanState: PlanState | null;
  capabilityAuditEvents: AuditEventRecord[];
  imageGenerationModelCatalog: ImageGenerationModelCatalog | null;
  onClose: () => void;
  onSave: (patch: UpdateUserSettings) => Promise<void>;
  onGrantCapabilityPermission: (capabilityId: string) => Promise<void>;
  onRevokeCapabilityPermission: (capabilityId: string) => Promise<void>;
  onPickAdditionalModelsDirectory: () => Promise<string | null>;
  onDiscoverImageModels: (
    additionalModelsDirectory?: string | null
  ) => Promise<ImageGenerationModelCatalog>;
}

function SelectShell(props: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const options: ThemedSelectOption[] = Children.toArray(props.children)
    .filter(isValidElement)
    .map((child) => {
      const optionProps = child.props as {
        value?: unknown;
        disabled?: boolean;
        children?: ReactNode;
      };

      return {
        value: getOptionValue(optionProps.value),
        label: getOptionText(optionProps.children).trim(),
        disabled: Boolean(optionProps.disabled)
      };
    });

  return (
    <ThemedSelect
      ariaLabel={props.ariaLabel}
      disabled={props.disabled}
      onChange={props.onChange}
      options={options}
      value={props.value}
    />
  );
}

function getOptionText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }

  if (Array.isArray(node)) {
    return node.map(getOptionText).join('');
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return getOptionText(props.children);
  }

  if (typeof node === 'string') {
    return node;
  }

  if (typeof node === 'number') {
    return String(node);
  }

  return '';
}

function getOptionValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return '';
}

function looksLikeLocalModelId(modelId: string): boolean {
  const normalized = modelId.trim();
  return (
    normalized.includes('\\') ||
    normalized.startsWith('.') ||
    normalized.startsWith('/') ||
    (normalized.length > 1 && normalized[1] === ':')
  );
}

function getPermissionClassLabel(permissionClass: ToolDefinition['permissionClass']) {
  if (permissionClass === 'always_confirm') {
    return 'Always confirm';
  }

  if (permissionClass === 'confirm_once') {
    return 'Grant once';
  }

  return 'No approval';
}

export function SettingsDrawer(props: SettingsDrawerProps) {
  const [draft, setDraft] = useState<UserSettings | null>(props.settings);
  const [localCatalog, setLocalCatalog] = useState<ImageGenerationModelCatalog | null>(
    props.imageGenerationModelCatalog
  );
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(props.settings);
  }, [props.settings]);

  useEffect(() => {
    setLocalCatalog(props.imageGenerationModelCatalog);
  }, [props.imageGenerationModelCatalog]);

  if (!props.open || !draft) {
    return null;
  }

  const modelOptions = Array.from(
    new Set(
      [
        draft.defaultModel,
        draft.codingModel,
        draft.visionModel,
        draft.videoGenerationModel,
        draft.videoGenerationHighNoiseModel,
        draft.videoGenerationLowNoiseModel,
        ...(draft.textInferenceBackend === 'nvidia'
          ? props.nvidiaModels
          : props.ollamaModels)
      ].filter(Boolean)
    )
  );
  const imageGenerationModelOptions = getImageGenerationModelOptions(
    localCatalog,
    draft.imageGenerationModel
  );
  const videoGenerationHighNoiseModelOptions = getVideoGenerationHighNoiseModelOptions(
    localCatalog,
    draft.videoGenerationHighNoiseModel
  );
  const videoGenerationLowNoiseModelOptions = getVideoGenerationLowNoiseModelOptions(
    localCatalog,
    draft.videoGenerationLowNoiseModel
  );
  const selectedImageGenerationOption =
    imageGenerationModelOptions.find((option) => option.id === draft.imageGenerationModel) ??
    null;
  const selectedVideoGenerationHighNoiseOption =
    videoGenerationHighNoiseModelOptions.find(
      (option) => option.id === draft.videoGenerationHighNoiseModel
    ) ?? null;
  const selectedVideoGenerationLowNoiseOption =
    videoGenerationLowNoiseModelOptions.find(
      (option) => option.id === draft.videoGenerationLowNoiseModel
    ) ?? null;
  const permissionByCapabilityId = new Map(
    props.capabilityPermissions.map((permission) => [permission.capabilityId, permission])
  );
  const permissionManagedCapabilities = props.capabilities.filter(
    (capability) => capability.permissionClass !== 'none'
  );

  async function refreshLocalImageCatalog(additionalModelsDirectory?: string | null) {
    try {
      setCatalogLoading(true);
      setCatalogError(null);
      const catalog = await props.onDiscoverImageModels(additionalModelsDirectory ?? null);
      setLocalCatalog(catalog);
      return catalog;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to inspect local image models.';
      setCatalogError(message);
      return null;
    } finally {
      setCatalogLoading(false);
    }
  }

  async function handlePickAdditionalModelsDirectory() {
    const pickedDirectory = await props.onPickAdditionalModelsDirectory();

    if (!pickedDirectory) {
      return;
    }

    setDraft((current) =>
      current
        ? {
            ...current,
            additionalModelsDirectory: pickedDirectory
          }
        : current
    );
    await refreshLocalImageCatalog(pickedDirectory);
  }

  async function handleClearAdditionalModelsDirectory() {
    setDraft((current) =>
      current
        ? {
            ...current,
            additionalModelsDirectory: null,
            imageGenerationModel: looksLikeLocalModelId(current.imageGenerationModel)
              ? 'builtin:placeholder'
              : current.imageGenerationModel,
            videoGenerationModel: looksLikeLocalModelId(current.videoGenerationModel)
              ? ''
              : current.videoGenerationModel,
            videoGenerationHighNoiseModel: looksLikeLocalModelId(
              current.videoGenerationHighNoiseModel
            )
              ? ''
              : current.videoGenerationHighNoiseModel,
            videoGenerationLowNoiseModel: looksLikeLocalModelId(
              current.videoGenerationLowNoiseModel
            )
              ? ''
              : current.videoGenerationLowNoiseModel
          }
        : current
    );
    await refreshLocalImageCatalog(null);
  }

  return (
    <div className="fixed inset-0 z-20 animate-fade-in bg-slate-950/50 backdrop-blur-sm">
      <button
        aria-label="Close settings"
        className="absolute inset-0 cursor-default"
        onClick={props.onClose}
        type="button"
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-xl justify-end">
        <aside className="motion-drawer-right relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-slate-950 px-6 py-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
                Settings
              </p>
              <h2 className="mt-2 text-3xl font-semibold text-white">
                Local runtime controls
              </h2>
            </div>
            <button
              className="motion-interactive rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={props.onClose}
              type="button"
            >
              Close
            </button>
          </div>

          <div className="mt-8 flex flex-1 flex-col gap-5 overflow-y-auto">
            <section className="motion-card rounded-[1.75rem] border border-white/10 bg-slate-900/60 px-5 py-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Model routing
                  </h3>
                  <p className="mt-2 text-sm text-slate-400">
                    Auto mode uses these roles to route simple chat, coding, and vision requests
                    turn by turn.
                  </p>
                </div>
                <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-200">
                  Auto-ready
                </span>
              </div>

              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Text backend
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Choose whether routed chat turns use the local Ollama runtime or the remote
                    NVIDIA chat API.
                  </p>
                  <SelectShell
                    ariaLabel="Text backend"
                    onChange={(value) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              textInferenceBackend: value as UserSettings['textInferenceBackend']
                            }
                          : current
                      )
                    }
                    value={draft.textInferenceBackend}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="nvidia">NVIDIA</option>
                  </SelectShell>
                  {draft.textInferenceBackend === 'nvidia' ? (
                    <p className="mt-3 text-xs text-amber-200">
                      NVIDIA is wired for text chat in this slice. Image attachment analysis still
                      routes through Ollama.
                    </p>
                  ) : null}
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    General (base)
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Used for normal chat and as the fallback when a specialized model is not set.
                  </p>
                  <SelectShell
                    ariaLabel="General (base)"
                    onChange={(value) =>
                      setDraft((current) =>
                        current ? { ...current, defaultModel: value } : current
                      )
                    }
                    value={draft.defaultModel}
                  >
                    <option value="">
                      {draft.textInferenceBackend === 'nvidia'
                        ? 'Use first available NVIDIA model'
                        : 'Use first available local model'}
                    </option>
                    {modelOptions.map((model) => (
                      <option
                        key={`general-${model}`}
                        value={model}
                      >
                        {model}
                      </option>
                    ))}
                  </SelectShell>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Coding
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Used when the router detects code-generation or debugging intent.
                  </p>
                  <SelectShell
                    ariaLabel="Coding"
                    onChange={(value) =>
                      setDraft((current) =>
                        current ? { ...current, codingModel: value } : current
                      )
                    }
                    value={draft.codingModel}
                  >
                    <option value="">Fall back to General (base)</option>
                    {modelOptions.map((model) => (
                      <option
                        key={`coding-${model}`}
                        value={model}
                      >
                        {model}
                      </option>
                    ))}
                  </SelectShell>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Vision
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Used when image attachments or vision-style prompts need a multimodal model.
                  </p>
                  <SelectShell
                    ariaLabel="Vision"
                    disabled={draft.textInferenceBackend === 'nvidia'}
                    onChange={(value) =>
                      setDraft((current) =>
                        current ? { ...current, visionModel: value } : current
                      )
                    }
                    value={draft.visionModel}
                  >
                    <option value="">
                      {draft.textInferenceBackend === 'nvidia'
                        ? 'Switch to Ollama for vision routing'
                        : 'Fall back to General (base)'}
                    </option>
                    {modelOptions.map((model) => (
                      <option
                        key={`vision-${model}`}
                        value={model}
                      >
                        {model}
                      </option>
                    ))}
                  </SelectShell>
                  {draft.textInferenceBackend === 'nvidia' ? (
                    <p className="mt-3 text-xs text-slate-500">
                      Vision routing stays disabled until the NVIDIA multimodal path is added.
                    </p>
                  ) : null}
                </label>

                <div className="motion-card rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <span className="block text-sm font-medium text-slate-200">
                        Additional models directory
                      </span>
                      <p className="mt-2 text-xs text-slate-400">
                        Point this at a local models root such as a ComfyUI `models` folder so
                        {APP_DISPLAY_NAME} can discover compatible image-generation weights,
                        including local diffusers folders, checkpoints, and supported GGUF
                        transformers.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="motion-interactive rounded-2xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        onClick={() => {
                          void handlePickAdditionalModelsDirectory();
                        }}
                        type="button"
                      >
                        Choose folder
                      </button>
                      <button
                        className="motion-interactive rounded-2xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        disabled={!draft.additionalModelsDirectory || catalogLoading}
                        onClick={() => {
                          void refreshLocalImageCatalog(draft.additionalModelsDirectory);
                        }}
                        type="button"
                      >
                        Refresh scan
                      </button>
                      <button
                        className="motion-interactive rounded-2xl border border-white/10 px-3 py-2 text-xs font-medium text-slate-100 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        disabled={!draft.additionalModelsDirectory || catalogLoading}
                        onClick={() => {
                          void handleClearAdditionalModelsDirectory();
                        }}
                        type="button"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-300">
                    {draft.additionalModelsDirectory ?? 'No additional models directory selected.'}
                  </div>

                  {catalogLoading ? (
                    <p className="motion-panel mt-3 text-xs text-cyan-200">
                      Scanning for compatible local image models...
                      <span className="motion-ellipsis" />
                    </p>
                  ) : null}

                  {catalogError ? (
                    <p className="motion-panel mt-3 text-xs text-rose-200">
                      {catalogError}
                    </p>
                  ) : null}

                  {localCatalog?.warnings.map((warning) => (
                    <p
                      key={warning}
                      className="mt-3 text-xs text-amber-200"
                    >
                      {warning}
                    </p>
                  ))}
                </div>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Image Gen
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Uses the Python generation worker. Local models discovered from the selected
                    directory appear here alongside the built-in placeholder backend. Qwen Image
                    Edit 2511 GGUF entries now route through the dedicated reference-image
                    workflow, while unsupported video-oriented GGUF families remain disabled.
                  </p>
                  <SelectShell
                    ariaLabel="Image Gen"
                    onChange={(value) =>
                      setDraft((current) =>
                        current ? { ...current, imageGenerationModel: value } : current
                      )
                    }
                    value={draft.imageGenerationModel}
                  >
                    {imageGenerationModelOptions.map((option) => (
                      <option
                        disabled={!option.supported}
                        key={`image-${option.id}`}
                        value={option.id}
                      >
                        {option.supported ? option.label : `${option.label} (Not available yet)`}
                      </option>
                    ))}
                  </SelectShell>
                  <p className="mt-3 text-xs text-slate-400">
                    {selectedImageGenerationOption?.description ??
                      'Select a local image model or use the built-in placeholder.'}
                  </p>
                  {selectedImageGenerationOption?.supportReason ? (
                    <p className="mt-2 text-xs text-amber-200">
                      {selectedImageGenerationOption.supportReason}
                    </p>
                  ) : null}
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Video Gen (High noise)
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Uses the embedded ComfyUI Wan 2.2 image-to-video flow. Pick the explicit
                    high-noise checkpoint required by the workflow.
                  </p>
                  <SelectShell
                    ariaLabel="Video Gen high noise"
                    onChange={(value) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              videoGenerationModel: value,
                              videoGenerationHighNoiseModel: value
                            }
                          : current
                      )
                    }
                    value={draft.videoGenerationHighNoiseModel}
                  >
                    <option value="">
                      Select a Wan high-noise model
                    </option>
                    {videoGenerationHighNoiseModelOptions.map((option) => (
                      <option
                        key={`video-high-${option.id}`}
                        value={option.id}
                      >
                        {option.label}
                      </option>
                    ))}
                  </SelectShell>
                  <p className="mt-3 text-xs text-slate-400">
                    {selectedVideoGenerationHighNoiseOption?.description ??
                      (videoGenerationHighNoiseModelOptions.length > 0
                        ? 'Select the local Wan high-noise checkpoint used for the first denoising pass.'
                        : 'No Wan 2.2 checkpoints are currently discovered in the selected models directories.')}
                  </p>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Video Gen (Low noise)
                  </span>
                  <p className="mb-3 text-xs text-slate-400">
                    Pick the explicit low-noise checkpoint required by the second Wan 2.2 pass.
                  </p>
                  <SelectShell
                    ariaLabel="Video Gen low noise"
                    onChange={(value) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              videoGenerationLowNoiseModel: value
                            }
                          : current
                      )
                    }
                    value={draft.videoGenerationLowNoiseModel}
                  >
                    <option value="">
                      Select a Wan low-noise model
                    </option>
                    {videoGenerationLowNoiseModelOptions.map((option) => (
                      <option
                        key={`video-low-${option.id}`}
                        value={option.id}
                      >
                        {option.label}
                      </option>
                    ))}
                  </SelectShell>
                  <p className="mt-3 text-xs text-slate-400">
                    {selectedVideoGenerationLowNoiseOption?.description ??
                      (videoGenerationLowNoiseModelOptions.length > 0
                        ? 'Select the local Wan low-noise checkpoint used for the finishing pass.'
                        : 'No Wan 2.2 checkpoints are currently discovered in the selected models directories.')}
                  </p>
                </label>
              </div>
            </section>

            <section className="motion-card rounded-[1.75rem] border border-white/10 bg-slate-900/60 px-5 py-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Agentic tools
                  </h3>
                  <p className="mt-2 text-sm text-slate-400">
                    Models can auto-pick these tools, but write-capable actions stay behind local
                    approval gates.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-300">
                  <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                    Tasks {props.capabilityTasks.length}
                  </span>
                  <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                    Schedules {props.capabilitySchedules.length}
                  </span>
                  <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                    Agents {props.capabilityAgents.length}
                  </span>
                  <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                    Teams {props.capabilityTeams.length}
                  </span>
                  <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                    Worktrees {props.capabilityWorktrees.length}
                  </span>
                </div>
              </div>

              <div className="motion-panel mt-5 rounded-2xl border border-dashed border-white/10 bg-slate-950/70 px-4 py-3 text-xs text-slate-300">
                Plan mode:{' '}
                <span className="font-medium text-slate-100">
                  {props.capabilityPlanState?.status ?? 'inactive'}
                </span>
                {props.capabilityPlanState?.summary ? ` | ${props.capabilityPlanState.summary}` : ''}
              </div>

              <div className="mt-5 space-y-3">
                {permissionManagedCapabilities.map((capability) => {
                  const permission = permissionByCapabilityId.get(capability.id) ?? null;

                  return (
                    <div
                      className="motion-card rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4"
                      key={capability.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-[14rem] flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-slate-100">
                              {capability.title}
                            </span>
                            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-300">
                              {capability.kind}
                            </span>
                            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-slate-300">
                              {getPermissionClassLabel(capability.permissionClass)}
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-slate-400">
                            {capability.description}
                          </p>
                          <p className="mt-2 text-[11px] text-slate-500">
                            {permission
                              ? `Granted ${permission.scopeKind} access${permission.expiresAt ? ` until ${permission.expiresAt}` : ''}.`
                              : 'No permission grant saved.'}
                          </p>
                        </div>

                        {permission ? (
                          <button
                            className="motion-interactive rounded-2xl border border-rose-300/20 px-3 py-2 text-xs font-medium text-rose-100 transition hover:border-rose-300/30 hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                            onClick={() => {
                              void props.onRevokeCapabilityPermission(capability.id);
                            }}
                            type="button"
                          >
                            Revoke
                          </button>
                        ) : (
                          <button
                            className="motion-interactive rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/30 hover:bg-cyan-400/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                            onClick={() => {
                              void props.onGrantCapabilityPermission(capability.id);
                            }}
                            type="button"
                          >
                            Grant
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="motion-card mt-5 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-4">
                <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-300">
                  Recent audit events
                </h4>
                <div className="mt-3 space-y-2 text-xs text-slate-300">
                  {props.capabilityAuditEvents.slice(0, 6).map((event) => (
                    <div
                      className="motion-panel rounded-xl border border-white/5 bg-slate-900/70 px-3 py-2"
                      key={event.id}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-slate-100">{event.action}</span>
                        <span className="text-slate-500">{event.createdAt}</span>
                      </div>
                      <p className="mt-1 text-slate-400">{event.summary}</p>
                    </div>
                  ))}
                  {props.capabilityAuditEvents.length === 0 ? (
                    <p className="text-slate-500">No audit events recorded yet.</p>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="motion-card rounded-[1.75rem] border border-white/10 bg-slate-900/60 px-5 py-5">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Text backend connections
                </h3>
                <p className="mt-2 text-sm text-slate-400">
                  Ollama stays local. NVIDIA requires a remote API key when that backend is
                  selected.
                </p>
              </div>

              <div className="mt-5 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    Ollama base URL
                  </span>
                  <input
                    className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, ollamaBaseUrl: event.target.value }
                          : current
                      )
                    }
                    type="url"
                    value={draft.ollamaBaseUrl}
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    NVIDIA base URL
                  </span>
                  <input
                    className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, nvidiaBaseUrl: event.target.value }
                          : current
                      )
                    }
                    type="url"
                    value={draft.nvidiaBaseUrl}
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-200">
                    NVIDIA API key
                  </span>
                  <input
                    className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, nvidiaApiKey: event.target.value }
                          : current
                      )
                    }
                    placeholder="nvapi-..."
                    type="password"
                    value={draft.nvidiaApiKey}
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Required whenever the active text backend is NVIDIA.
                  </p>
                </label>
              </div>
            </section>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-200">
                Python server port
              </span>
              <input
                className="w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                min={1024}
                max={65535}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, pythonPort: Number(event.target.value) }
                      : current
                  )
                }
                type="number"
                value={draft.pythonPort}
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-200">
                Theme
              </span>
              <SelectShell
                ariaLabel="Theme"
                onChange={(value) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          theme: value as UserSettings['theme']
                        }
                      : current
                  )
                }
                value={draft.theme}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </SelectShell>
            </label>

            <section className="motion-card rounded-[1.75rem] border border-white/10 bg-slate-900/60 px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-100">
                    Streaming mascot
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Show the hammer mascot while assistant responses are streaming.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={`text-xs font-semibold uppercase tracking-[0.18em] ${
                      draft.streamingMascotEnabled ? 'text-cyan-100' : 'text-slate-500'
                    }`}
                  >
                    {draft.streamingMascotEnabled ? 'On' : 'Off'}
                  </span>
                  <button
                    aria-checked={draft.streamingMascotEnabled}
                    aria-label="Streaming mascot"
                    className={`relative h-8 w-14 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                      draft.streamingMascotEnabled
                        ? 'border-cyan-300/40 bg-cyan-400/25'
                        : 'border-white/10 bg-slate-950'
                    }`}
                    onClick={() =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              streamingMascotEnabled: !current.streamingMascotEnabled
                            }
                          : current
                      )
                    }
                    role="switch"
                    type="button"
                  >
                    <span
                      className={`absolute left-1 top-1 h-6 w-6 rounded-full bg-slate-100 shadow-sm transition-transform ${
                        draft.streamingMascotEnabled ? 'translate-x-6' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </section>
          </div>

          <button
            className="motion-interactive mt-6 rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            onClick={() => {
              void (async () => {
                await props.onSave(draft);
                props.onClose();
              })();
            }}
            type="button"
          >
            Save settings
          </button>
        </aside>
      </div>
    </div>
  );
}
