import { useEffect, useMemo, useState } from 'react';
import type {
  CreatePersonaInput,
  PersonaDefinition,
  UpdatePersonaInput
} from '@bridge/ipc/contracts';
import { formatTimestamp } from '@renderer/lib/format';
import { useEscapeClose } from '@renderer/lib/use-escape-close';
import { useFocusTrap } from '@renderer/lib/use-focus-trap';

type WizardStep = 1 | 2 | 3;

interface PersonasDrawerProps {
  open: boolean;
  personas: PersonaDefinition[];
  activePersonaId: string | null;
  onClose?: (() => void) | undefined;
  onCreatePersona: (input: CreatePersonaInput) => Promise<void>;
  onUpdatePersona: (input: UpdatePersonaInput) => Promise<void>;
  onDeletePersona: (personaId: string) => Promise<void>;
  onSetActivePersona: (personaId: string | null) => Promise<void>;
}

interface PersonaWizardDraft {
  personaId: string | null;
  name: string;
  prompt: string;
}

function isPersonaReadOnly(persona: PersonaDefinition) {
  return persona.source === 'builtin';
}

function createEmptyDraft(): PersonaWizardDraft {
  return {
    personaId: null,
    name: '',
    prompt: ''
  };
}

function StepBadge(props: { active: boolean; complete: boolean; label: string; step: WizardStep }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`motion-interactive flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold ${
          props.active
            ? 'bg-cyan-400 text-slate-950'
            : props.complete
              ? 'bg-emerald-400/20 text-emerald-200'
              : 'bg-white/5 text-slate-400'
        }`}
      >
        {props.step}
      </span>
      <span className={props.active ? 'text-sm font-medium text-slate-100' : 'text-sm text-slate-400'}>
        {props.label}
      </span>
    </div>
  );
}

function PersonaCard(props: {
  persona: PersonaDefinition;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const readOnly = isPersonaReadOnly(props.persona);

  return (
    <div
      className={`motion-card rounded-2xl border px-4 py-3 cursor-pointer transition ${
        props.active
          ? 'border-cyan-400/50 bg-cyan-400/15'
          : props.selected
            ? 'border-cyan-300/30 bg-cyan-400/10'
            : 'border-white/10 bg-slate-950/45 hover:border-white/20'
      }`}
      onClick={props.onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          props.onSelect();
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{props.persona.name}</h3>
            {props.active ? (
              <span className="rounded-full bg-cyan-400/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-cyan-200">
                Active
              </span>
            ) : null}
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${
                readOnly
                  ? 'bg-slate-400/15 text-slate-300'
                  : 'bg-emerald-400/15 text-emerald-200'
              }`}
            >
              {readOnly ? 'Built-in' : 'User'}
            </span>
          </div>
          <p className="mt-2 font-mono text-[11px] text-slate-500">{props.persona.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!readOnly ? (
            <button
              className="motion-interactive rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={(event) => {
                event.stopPropagation();
                props.onEdit();
              }}
              type="button"
            >
              Edit
            </button>
          ) : null}
          {props.onDelete ? (
            <button
              className="motion-interactive rounded-full border border-rose-400/20 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-rose-200 transition hover:bg-rose-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
              onClick={(event) => {
                event.stopPropagation();
                props.onDelete?.();
              }}
              type="button"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
      {props.persona.updatedAt ? (
        <p className="mt-2 text-[11px] text-slate-500">Updated {formatTimestamp(props.persona.updatedAt)}</p>
      ) : null}
    </div>
  );
}

export function PersonasDrawer(props: PersonasDrawerProps) {
  useEscapeClose(props.open, props.onClose);
  const focusRef = useFocusTrap(props.open);
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<PersonaWizardDraft>(createEmptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtinPersonas = useMemo(
    () => props.personas.filter((persona) => isPersonaReadOnly(persona)),
    [props.personas]
  );
  const userPersonas = useMemo(
    () => props.personas.filter((persona) => !isPersonaReadOnly(persona)),
    [props.personas]
  );

  useEffect(() => {
    if (!props.open) {
      setWizardStep(1);
      setDraft(createEmptyDraft());
      setSaving(false);
      setError(null);
    }
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const editingExistingPersona = draft.personaId !== null;
  const basicsComplete = draft.name.trim().length > 0;
  const promptComplete = draft.prompt.trim().length > 0;

  function beginCreatePersona() {
    setDraft(createEmptyDraft());
    setWizardStep(1);
    setError(null);
  }

  function beginEditPersona(persona: PersonaDefinition) {
    setDraft({
      personaId: persona.id,
      name: persona.name,
      prompt: persona.prompt
    });
    setWizardStep(1);
    setError(null);
  }

  async function handleDeletePersona(personaId: string) {
    const persona = props.personas.find((p) => p.id === personaId);
    const confirmed = window.confirm(
      `Delete persona "${persona?.name ?? personaId}"? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await props.onDeletePersona(personaId);

      if (draft.personaId === personaId) {
        beginCreatePersona();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to delete persona.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePersona() {
    if (!basicsComplete || !promptComplete) {
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (editingExistingPersona) {
        await props.onUpdatePersona({
          personaId: draft.personaId!,
          name: draft.name.trim(),
          prompt: draft.prompt.trim()
        });
      } else {
        await props.onCreatePersona({
          name: draft.name.trim(),
          prompt: draft.prompt.trim()
        });
      }

      beginCreatePersona();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save persona.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSelectPersona(personaId: string) {
    try {
      await props.onSetActivePersona(personaId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to set active persona.');
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex animate-fade-in justify-center px-6">
      <section ref={focusRef} role="dialog" aria-modal="true" aria-label="Personas" className="motion-drawer-up pointer-events-auto flex max-h-[calc(78vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Personas</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Persona registry</h2>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">
              Built-in personas ship with the app. User personas live in local SQLite and shape the assistant's tone and style for every chat turn.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="motion-interactive rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={beginCreatePersona}
              type="button"
            >
              New persona
            </button>
            {props.onClose ? (
              <button
                aria-label="Close personas drawer"
                className="motion-interactive rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onClick={props.onClose}
                type="button"
              >
                Close
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="motion-card min-h-0 space-y-4 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">Available personas</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {builtinPersonas.length} built-in, {userPersonas.length} user-defined
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    User personas
                  </p>
                  {userPersonas.length === 0 ? (
                    <p className="motion-panel rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                      No user personas yet. Use the wizard to add one to local storage.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {userPersonas.map((persona) => (
                        <PersonaCard
                          key={persona.id}
                          active={props.activePersonaId === persona.id}
                          onDelete={() => {
                            void handleDeletePersona(persona.id);
                          }}
                          onEdit={() => beginEditPersona(persona)}
                          onSelect={() => {
                            void handleSelectPersona(persona.id);
                          }}
                          selected={draft.personaId === persona.id}
                          persona={persona}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    Built-in personas
                  </p>
                  <div className="space-y-2">
                    {builtinPersonas.map((persona) => (
                      <PersonaCard
                        key={persona.id}
                        active={props.activePersonaId === persona.id}
                        onEdit={() => beginEditPersona(persona)}
                        onSelect={() => {
                          void handleSelectPersona(persona.id);
                        }}
                        selected={draft.personaId === persona.id}
                        persona={persona}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="motion-card space-y-4 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
                  {editingExistingPersona ? 'Edit persona' : 'Create persona'}
                </p>
                <h3 className="mt-2 text-xl font-semibold text-white">
                  {editingExistingPersona ? draft.name || draft.personaId : 'New persona wizard'}
                </h3>
              </div>

              <div className="flex flex-wrap gap-3">
                <StepBadge
                  active={wizardStep === 1}
                  complete={wizardStep > 1}
                  label="Name"
                  step={1}
                />
                <StepBadge
                  active={wizardStep === 2}
                  complete={wizardStep > 2}
                  label="Prompt"
                  step={2}
                />
                <StepBadge
                  active={wizardStep === 3}
                  complete={false}
                  label="Review"
                  step={3}
                />
              </div>

              {error ? (
                <div className="motion-panel rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}

              {wizardStep === 1 ? (
                <div className="space-y-4">
                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-200">Name</span>
                    <input
                      aria-label="Name"
                      className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      onChange={(event) => {
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value
                        }));
                      }}
                      placeholder="Socratic tutor"
                      value={draft.name}
                    />
                  </label>
                </div>
              ) : null}

              {wizardStep === 2 ? (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400">
                    Define the persona prompt. This is injected as a system message on every chat turn.
                  </p>
                  <textarea
                    aria-label="Prompt"
                    className="min-h-72 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        prompt: event.target.value
                      }))
                    }
                    placeholder="You are a patient tutor who answers questions with guiding questions."
                    value={draft.prompt}
                  />
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div className="space-y-4">
                  <div className="motion-panel rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-slate-100">{draft.name || 'Untitled persona'}</p>
                      <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200">
                        User
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-300">{draft.prompt}</p>
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
                <button
                  className="motion-interactive rounded-2xl border border-white/10 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                  disabled={wizardStep === 1 || saving}
                  onClick={() => setWizardStep((current) => Math.max(1, current - 1) as WizardStep)}
                  type="button"
                >
                  Back
                </button>
                <div className="flex items-center gap-2">
                  <button
                    className="motion-interactive rounded-2xl border border-white/10 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                    disabled={saving}
                    onClick={beginCreatePersona}
                    type="button"
                  >
                    Reset
                  </button>
                  {wizardStep < 3 ? (
                    <button
                      className="motion-interactive rounded-2xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                      disabled={saving || (wizardStep === 1 ? !basicsComplete : !promptComplete)}
                      onClick={() =>
                        setWizardStep((current) => Math.min(3, current + 1) as WizardStep)
                      }
                      type="button"
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      className="motion-interactive rounded-2xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
                      disabled={saving || !basicsComplete || !promptComplete}
                      onClick={() => {
                        void handleSavePersona();
                      }}
                      type="button"
                    >
                      {saving ? 'Saving...' : editingExistingPersona ? 'Save changes' : 'Create persona'}
                    </button>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
