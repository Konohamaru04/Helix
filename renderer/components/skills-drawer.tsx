import { useEffect, useMemo, useState } from 'react';
import type {
  CreateSkillInput,
  SkillDefinition,
  UpdateSkillInput
} from '@bridge/ipc/contracts';
import { formatTimestamp } from '@renderer/lib/format';

type WizardStep = 1 | 2 | 3;

interface SkillsDrawerProps {
  open: boolean;
  skills: SkillDefinition[];
  onClose?: (() => void) | undefined;
  onCreateSkill: (input: CreateSkillInput) => Promise<void>;
  onUpdateSkill: (input: UpdateSkillInput) => Promise<void>;
  onDeleteSkill: (skillId: string) => Promise<void>;
}

interface SkillWizardDraft {
  skillId: string | null;
  title: string;
  description: string;
  prompt: string;
}

function slugifySkillId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

function createEmptyDraft(): SkillWizardDraft {
  return {
    skillId: null,
    title: '',
    description: '',
    prompt: ''
  };
}

function isSkillReadOnly(skill: SkillDefinition) {
  return skill.readOnly ?? skill.source === 'builtin';
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

function SkillCard(props: {
  skill: SkillDefinition;
  selected: boolean;
  onEdit: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const readOnly = isSkillReadOnly(props.skill);

  return (
    <div
      className={`motion-card rounded-2xl border px-4 py-3 ${
        props.selected
          ? 'border-cyan-300/30 bg-cyan-400/10'
          : 'border-white/10 bg-slate-950/45'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{props.skill.title}</h3>
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
          <p className="mt-1 text-xs text-slate-400">{props.skill.description}</p>
          <p className="mt-2 font-mono text-[11px] text-slate-500">@{props.skill.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!readOnly ? (
            <button
              className="motion-interactive rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={props.onEdit}
              type="button"
            >
              Edit
            </button>
          ) : null}
          {props.onDelete ? (
            <button
              className="motion-interactive rounded-full border border-rose-400/20 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-rose-200 transition hover:bg-rose-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
              onClick={props.onDelete}
              type="button"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
      {props.skill.updatedAt ? (
        <p className="mt-2 text-[11px] text-slate-500">Updated {formatTimestamp(props.skill.updatedAt)}</p>
      ) : null}
    </div>
  );
}

export function SkillsDrawer(props: SkillsDrawerProps) {
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<SkillWizardDraft>(createEmptyDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtinSkills = useMemo(
    () => props.skills.filter((skill) => isSkillReadOnly(skill)),
    [props.skills]
  );
  const userSkills = useMemo(
    () => props.skills.filter((skill) => !isSkillReadOnly(skill)),
    [props.skills]
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

  const editingExistingSkill = draft.skillId !== null;
  const generatedSkillIdPreview = draft.skillId ?? (slugifySkillId(draft.title) || 'skill');
  const basicsComplete = draft.title.trim().length > 0 && draft.description.trim().length > 0;
  const promptComplete = draft.prompt.trim().length > 0;

  function beginCreateSkill() {
    setDraft(createEmptyDraft());
    setWizardStep(1);
    setError(null);
  }

  function beginEditSkill(skill: SkillDefinition) {
    setDraft({
      skillId: skill.id,
      title: skill.title,
      description: skill.description,
      prompt: skill.prompt
    });
    setWizardStep(1);
    setError(null);
  }

  async function handleDeleteSkill(skillId: string) {
    const confirmed = window.confirm(
      `Delete skill "${skillId}" from local storage? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setSaving(true);
      setError(null);
      await props.onDeleteSkill(skillId);

      if (draft.skillId === skillId) {
        beginCreateSkill();
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to delete skill.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSkill() {
    if (!basicsComplete || !promptComplete) {
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (editingExistingSkill) {
        await props.onUpdateSkill({
          skillId: draft.skillId!,
          title: draft.title.trim(),
          description: draft.description.trim(),
          prompt: draft.prompt.trim()
        });
      } else {
        await props.onCreateSkill({
          title: draft.title.trim(),
          description: draft.description.trim(),
          prompt: draft.prompt.trim()
        });
      }

      beginCreateSkill();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to save skill.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex animate-fade-in justify-center px-6">
      <section className="motion-drawer-up pointer-events-auto flex max-h-[calc(78vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Skills</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Skill registry</h2>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">
              Built-in skills stay synced from the packaged runtime. User skills live in local
              SQLite and are available to routing immediately after save.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="motion-interactive rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={beginCreateSkill}
              type="button"
            >
              New skill
            </button>
            {props.onClose ? (
              <button
                aria-label="Close skills drawer"
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
                  <h3 className="text-sm font-semibold text-slate-100">Available skills</h3>
                  <p className="mt-1 text-xs text-slate-400">
                    {builtinSkills.length} built-in, {userSkills.length} user-defined
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    User skills
                  </p>
                  {userSkills.length === 0 ? (
                    <p className="motion-panel rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                      No user skills yet. Use the wizard to add one to local storage.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {userSkills.map((skill) => (
                        <SkillCard
                          key={skill.id}
                          onDelete={() => {
                            void handleDeleteSkill(skill.id);
                          }}
                          onEdit={() => beginEditSkill(skill)}
                          selected={draft.skillId === skill.id}
                          skill={skill}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">
                    Built-in skills
                  </p>
                  <div className="space-y-2">
                    {builtinSkills.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        onEdit={() => beginEditSkill(skill)}
                        selected={draft.skillId === skill.id}
                        skill={skill}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="motion-card space-y-4 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
                  {editingExistingSkill ? 'Edit skill' : 'Create skill'}
                </p>
                <h3 className="mt-2 text-xl font-semibold text-white">
                  {editingExistingSkill ? draft.title || draft.skillId : 'New skill wizard'}
                </h3>
              </div>

              <div className="flex flex-wrap gap-3">
                <StepBadge
                  active={wizardStep === 1}
                  complete={wizardStep > 1}
                  label="Basics"
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
                          title: event.target.value
                        }));
                      }}
                      placeholder="Grounded reviewer"
                      value={draft.title}
                    />
                  </label>

                  <div className="motion-panel rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3">
                    <p className="text-sm font-medium text-slate-200">
                      {editingExistingSkill ? 'Skill ID' : 'Generated skill ID'}
                    </p>
                    <p className="mt-2 font-mono text-sm text-slate-100">
                      @{generatedSkillIdPreview}
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                      {editingExistingSkill
                        ? 'Skill IDs stay stable after creation so existing routing references keep working.'
                        : 'The bridge generates the final ID on save and adds a numeric suffix automatically if this slug is already taken.'}
                    </p>
                  </div>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-200">Description</span>
                    <textarea
                      aria-label="Description"
                      className="min-h-24 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          description: event.target.value
                        }))
                      }
                      placeholder="Use when answers should stay grounded in local sources and include provenance."
                      value={draft.description}
                    />
                  </label>
                </div>
              ) : null}

              {wizardStep === 2 ? (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400">
                    Define the actual skill prompt. This is what the bridge will inject when the
                    skill is active.
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
                    placeholder="Explain how the assistant should behave when this skill is active."
                    value={draft.prompt}
                  />
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div className="space-y-4">
                  <div className="motion-panel rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-slate-100">{draft.title || 'Untitled skill'}</p>
                      <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200">
                        User
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-xs text-slate-500">@{generatedSkillIdPreview}</p>
                    <p className="mt-3 text-sm leading-6 text-slate-300">{draft.description}</p>
                  </div>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium text-slate-200">Prompt preview</span>
                    <textarea
                      aria-label="Prompt preview"
                      className="min-h-72 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          prompt: event.target.value
                        }))
                      }
                      value={draft.prompt}
                    />
                  </label>
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
                    onClick={beginCreateSkill}
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
                        void handleSaveSkill();
                      }}
                      type="button"
                    >
                      {saving ? 'Saving...' : editingExistingSkill ? 'Save changes' : 'Create skill'}
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
