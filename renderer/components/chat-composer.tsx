import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { MessageAttachment, SkillDefinition } from '@bridge/ipc/contracts';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import { AttachmentCard } from '@renderer/components/attachment-card';

interface ChatComposerProps {
  disabled: boolean;
  submitDisabled?: boolean;
  editing: boolean;
  streaming: boolean;
  submitting?: boolean;
  submitLabel?: string | null;
  submitHint?: string | null;
  generationMode: 'chat' | 'image' | 'video' | 'wireframe';
  imageGenerationAvailable: boolean;
  imageGenerationModelLabel: string | null;
  videoGenerationAvailable: boolean;
  videoGenerationModelLabel: string | null;
  prompt: string;
  attachments: MessageAttachment[];
  activeWorkspaceName: string | null;
  workspaceRootPath: string | null;
  knowledgeDocumentCount: number;
  workspaceActionsEnabled: boolean;
  availableSkills: SkillDefinition[];
  activePersonaName?: string | null;
  onPromptChange: (prompt: string) => void;
  onAttach: () => Promise<void>;
  onEnterImageMode: () => void;
  onEnterVideoMode: () => void;
  onExitImageMode: () => void;
  onExitVideoMode: () => void;
  onToggleWireframeMode: () => void;
  onImportWorkspaceKnowledge: () => Promise<void>;
  onRemoveAttachment: (attachmentId: string) => void;
  onCancelEdit: () => void;
  onSubmit: () => Promise<void>;
  onStop?: () => Promise<void>;
}

type ComposerMenu = 'add' | 'workspace' | null;

interface MentionState {
  open: boolean;
  query: string;
  index: number;
  start: number;
}

function getMentionQueryAtCursor(
  value: string,
  cursor: number
): { query: string; start: number } | null {
  let index = cursor - 1;

  while (index >= 0 && /\S/.test(value[index] ?? '')) {
    index -= 1;
  }

  const word = value.slice(index + 1, cursor);

  if (!word.startsWith('@')) {
    return null;
  }

  return {
    query: word.slice(1).toLowerCase(),
    start: index + 1
  };
}

export function ChatComposer(props: ChatComposerProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const mentionRef = useRef<HTMLDivElement | null>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [mention, setMention] = useState<MentionState>({
    open: false,
    query: '',
    index: 0,
    start: 0
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setActiveMenu(null);
      }

      if (!mentionRef.current?.contains(event.target as Node)) {
        setMention((current) => ({ ...current, open: false }));
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  const filteredSkills = props.availableSkills.filter((skill) =>
    skill.id.toLowerCase().includes(mention.query) ||
    skill.title.toLowerCase().includes(mention.query)
  );

  function openMention(query: string, start: number) {
    setMention({
      open: true,
      query,
      index: 0,
      start
    });
  }

  function closeMention() {
    setMention((current) => ({ ...current, open: false }));
  }

  function insertMention(skill: SkillDefinition) {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    const before = props.prompt.slice(0, mention.start);
    const after = props.prompt.slice(textarea.selectionStart);
    const replacement = `@${skill.id} `;
    const nextPrompt = before + replacement + after;

    props.onPromptChange(nextPrompt);
    closeMention();

    requestAnimationFrame(() => {
      const cursorPosition = before.length + replacement.length;
      textarea.focus();
      textarea.setSelectionRange(cursorPosition, cursorPosition);
    });
  }

  function handlePromptChange(value: string) {
    const textarea = textareaRef.current;

    if (!textarea) {
      props.onPromptChange(value);
      return;
    }

    const cursor = textarea.selectionStart;
    const result = getMentionQueryAtCursor(value, cursor);

    if (result) {
      openMention(result.query, result.start);
    } else {
      closeMention();
    }

    props.onPromptChange(value);
  }

  function handleMentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention.open || filteredSkills.length === 0) {
      return false;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMention((current) => ({
        ...current,
        index: (current.index + 1) % filteredSkills.length
      }));
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMention((current) => ({
        ...current,
        index:
          (current.index - 1 + filteredSkills.length) % filteredSkills.length
      }));
      return true;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = filteredSkills[mention.index];

      if (selected) {
        insertMention(selected);
      }

      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMention();
      return true;
    }

    return false;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!props.prompt.trim() || props.disabled) {
      return;
    }

    setActiveMenu(null);
    await props.onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (handleMentionKeyDown(event)) {
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  async function handleAttachClick() {
    setActiveMenu(null);
    await props.onAttach();
  }

  function handleImageModeClick() {
    setActiveMenu(null);
    props.onEnterImageMode();
    textareaRef.current?.focus();
  }

  function handleVideoModeClick() {
    setActiveMenu(null);
    props.onEnterVideoMode();
    textareaRef.current?.focus();
  }

  async function handleImportKnowledgeClick() {
    setActiveMenu(null);
    await props.onImportWorkspaceKnowledge();
  }

  const visibleSubmitLabel =
    props.submitLabel ??
    (props.generationMode === 'image'
      ? 'Generating...'
      : props.generationMode === 'video'
        ? 'Rendering video...'
        : props.generationMode === 'wireframe'
          ? 'Designing...'
          : props.editing
          ? 'Resending...'
          : 'Sending...');

  return (
    <form
      aria-busy={props.submitting ? true : undefined}
      data-mascot-target="composer"
      ref={formRef}
      className="motion-panel border-t border-white/10 bg-slate-950/70 px-4 py-4 backdrop-blur sm:px-6"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="mx-auto flex max-w-[88rem] flex-col gap-3">
        {props.editing ? (
          <div className="motion-panel flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-100/80">
                Editing
              </p>
              <p className="mt-1 text-sm text-cyan-50">
                Resend the updated message and replace the current reply chain.
              </p>
            </div>
            <button
              className="motion-interactive rounded-xl border border-cyan-100/20 px-3 py-1.5 text-xs font-medium text-cyan-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              onClick={props.onCancelEdit}
              type="button"
            >
              Cancel edit
            </button>
          </div>
        ) : null}

        {props.generationMode === 'image' ? (
          <div className="motion-panel flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-fuchsia-300/20 bg-fuchsia-500/10 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-fuchsia-100/80">
                Image generation
              </p>
              <p className="mt-1 text-sm text-fuchsia-50">
                This chat composer is now creating an inline image turn.
                {props.imageGenerationModelLabel
                  ? ` Current backend: ${props.imageGenerationModelLabel}.`
                  : ''}
                {' '}
                Attach one or more images to use them as reference inputs, and the job will stay in this chat timeline.
              </p>
            </div>
            <button
              className="motion-interactive rounded-xl border border-fuchsia-100/20 px-3 py-1.5 text-xs font-medium text-fuchsia-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-300"
              onClick={props.onExitImageMode}
              type="button"
            >
              Back to chat
            </button>
          </div>
        ) : null}

        {props.generationMode === 'video' ? (
          <div className="motion-panel flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-orange-300/20 bg-orange-500/10 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-orange-100/80">
                Image to video
              </p>
              <p className="mt-1 text-sm text-orange-50">
                This chat composer is now creating an inline Wan 2.2 video turn.
                {props.videoGenerationModelLabel
                  ? ` Current backend: ${props.videoGenerationModelLabel}.`
                  : ''}
                {' '}
                Attach exactly one start image and the bridge will use the configured
                high-noise and low-noise checkpoints before queueing the job.
              </p>
            </div>
            <button
              className="motion-interactive rounded-xl border border-orange-100/20 px-3 py-1.5 text-xs font-medium text-orange-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
              onClick={props.onExitVideoMode}
              type="button"
            >
              Back to chat
            </button>
          </div>
        ) : null}

        {props.generationMode === 'wireframe' ? (
          <div className="motion-panel flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-cyan-300/20 bg-cyan-400/10 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-100/80">
                Wireframe mode
              </p>
              <p className="mt-1 text-sm text-cyan-50">
                Describe the product idea, answer multiple-choice follow-ups, and the model will generate a live canvas.
              </p>
            </div>
            {/* <button
              className="motion-interactive rounded-xl border border-cyan-100/20 px-3 py-1.5 text-xs font-medium text-cyan-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              onClick={props.onToggleWireframeMode}
              type="button"
            >
              Back to chat
            </button> */}
          </div>
        ) : null}

        {props.attachments.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {props.attachments.map((attachment) => (
              <AttachmentCard
                key={attachment.id}
                attachment={attachment}
                onRemove={props.onRemoveAttachment}
              />
            ))}
          </div>
        ) : null}

        <div className="motion-focus-ring rounded-[1.75rem] border border-white/10 bg-slate-900/70 p-3 shadow-panel relative">
          <textarea
            ref={textareaRef}
            id="chat-prompt"
            aria-label="Message prompt"
            className="h-28 w-full resize-none overflow-y-auto rounded-[1.35rem] border border-transparent bg-transparent px-3 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            disabled={props.disabled}
            onChange={(event) => handlePromptChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              props.generationMode === 'image'
                ? 'Describe the image you want to generate'
                : props.generationMode === 'video'
                  ? 'Describe the motion, camera movement, and style for the video'
                  : props.generationMode === 'wireframe'
                    ? 'Describe the application idea, users, screens, workflows, and design constraints'
                    : `Message ${APP_DISPLAY_NAME}`
            }
            rows={4}
            value={props.prompt}
          />

          {mention.open && filteredSkills.length > 0 ? (
            <div
              ref={mentionRef}
              className="absolute bottom-full left-0 z-30 mb-2 w-full max-w-sm rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
              role="listbox"
              aria-label="Skill suggestions"
            >
              <div className="max-h-48 overflow-y-auto space-y-0.5">
                {filteredSkills.map((skill, index) => (
                  <button
                    key={skill.id}
                    className={`motion-interactive flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                      index === mention.index
                        ? 'bg-white/5 text-cyan-50'
                        : 'text-slate-100 hover:bg-white/5'
                    }`}
                    onClick={() => insertMention(skill)}
                    onMouseEnter={() =>
                      setMention((current) => ({ ...current, index }))
                    }
                    role="option"
                    aria-selected={index === mention.index}
                    type="button"
                  >
                    <span className="font-medium">@{skill.id}</span>
                    <span
                      className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                        skill.source === 'builtin'
                          ? 'bg-cyan-400/15 text-cyan-200'
                          : 'bg-emerald-400/15 text-emerald-200'
                      }`}
                    >
                      {skill.source}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {props.submitting ? (
            <div
              aria-live="polite"
              className="motion-loader-sweep motion-panel flex items-center gap-3 rounded-2xl border border-cyan-300/10 bg-cyan-400/5 px-3 py-2 text-sm text-cyan-100"
              role="status"
            >
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 rounded-full border-2 border-cyan-200/25 border-t-cyan-200 motion-reduce:animate-none motion-safe:animate-spin"
              />
              <div>
                <p className="font-medium text-cyan-50">{visibleSubmitLabel}</p>
                <p className="text-xs text-cyan-100/75">
                  {props.submitHint ?? 'Processing your request.'}
                  <span className="motion-ellipsis" />
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 px-2 pt-3">
            <div
              className="flex flex-wrap items-center gap-2"
              ref={menuRef}
            >
              <div className="relative">
                <button
                  aria-expanded={activeMenu === 'add'}
                  aria-haspopup="menu"
                  aria-label="Open add menu"
                  className="motion-interactive inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-lg text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                  disabled={props.disabled}
                  onClick={() =>
                    setActiveMenu((current) => (current === 'add' ? null : 'add'))
                  }
                  type="button"
                >
                  +
                </button>

                {activeMenu === 'add' ? (
                  <div
                    className="motion-menu-pop absolute bottom-12 left-0 z-20 min-w-44 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
                    role="menu"
                  >
                    <button
                      className="motion-interactive flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      onClick={() => {
                        void handleAttachClick();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {props.generationMode === 'image'
                        ? 'Attach reference images'
                        : props.generationMode === 'video'
                          ? 'Attach start image'
                          : 'Attach files'}
                    </button>
                    <button
                      className="motion-interactive flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      disabled={!props.imageGenerationAvailable}
                      onClick={handleImageModeClick}
                      role="menuitem"
                      type="button"
                    >
                      Generate image
                    </button>
                    <button
                      className="motion-interactive flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      disabled={!props.videoGenerationAvailable}
                      onClick={handleVideoModeClick}
                      role="menuitem"
                      type="button"
                    >
                      Generate video
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="relative">
                <button
                  aria-expanded={activeMenu === 'workspace'}
                  aria-haspopup="menu"
                  aria-label="Open workspace settings"
                  className="motion-interactive inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                  disabled={!props.workspaceActionsEnabled}
                  onClick={() =>
                    setActiveMenu((current) =>
                      current === 'workspace' ? null : 'workspace'
                    )
                  }
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M10.3 2.95a1 1 0 0 1 1.4 0l.67.67a1 1 0 0 0 1.02.24l.91-.3a1 1 0 0 1 1.25.6l.36.88a1 1 0 0 0 .82.62l.95.12a1 1 0 0 1 .87.99v.95a1 1 0 0 0 .5.87l.82.47a1 1 0 0 1 .37 1.36l-.47.82a1 1 0 0 0 0 1l.47.82a1 1 0 0 1-.37 1.36l-.82.47a1 1 0 0 0-.5.87v.95a1 1 0 0 1-.87.99l-.95.12a1 1 0 0 0-.82.62l-.36.88a1 1 0 0 1-1.25.6l-.91-.3a1 1 0 0 0-1.02.24l-.67.67a1 1 0 0 1-1.4 0l-.67-.67a1 1 0 0 0-1.02-.24l-.91.3a1 1 0 0 1-1.25-.6l-.36-.88a1 1 0 0 0-.82-.62l-.95-.12a1 1 0 0 1-.87-.99v-.95a1 1 0 0 0-.5-.87l-.82-.47a1 1 0 0 1-.37-1.36l.47-.82a1 1 0 0 0 0-1l-.47-.82a1 1 0 0 1 .37-1.36l.82-.47a1 1 0 0 0 .5-.87v-.95a1 1 0 0 1 .87-.99l.95-.12a1 1 0 0 0 .82-.62l.36-.88a1 1 0 0 1 1.25-.6l.91.3a1 1 0 0 0 1.02-.24l.67-.67Z"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.4"
                    />
                    <circle
                      cx="12"
                      cy="12"
                      r="3.2"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
                </button>

                {activeMenu === 'workspace' ? (
                  <div
                    className="motion-menu-pop absolute bottom-12 left-0 z-20 min-w-64 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
                    role="menu"
                  >
                    <div className="border-b border-white/10 px-3 pb-3 pt-2">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-200/70">
                        Workspace
                      </p>
                      <p className="mt-2 text-sm font-medium text-slate-100">
                        {props.activeWorkspaceName ?? 'No workspace selected'}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {props.workspaceRootPath
                          ? props.workspaceRootPath
                          : 'This workspace has no folder binding. New workspaces now require a folder during creation.'}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {props.knowledgeDocumentCount} knowledge document
                        {props.knowledgeDocumentCount === 1 ? '' : 's'}
                      </p>
                    </div>

                    <div className="space-y-1 pt-2">
                      <button
                        className="motion-interactive flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        onClick={() => {
                          void handleImportKnowledgeClick();
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Add docs
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {props.activePersonaName ? (
                <span className="inline-flex h-10 items-center rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100">
                  {props.activePersonaName}
                </span>
              ) : null}
              <button
                aria-pressed={props.generationMode === 'wireframe'}
                aria-label={
                  props.generationMode === 'wireframe'
                    ? 'Disable wireframe mode'
                    : 'Enable wireframe mode'
                }
                className={`motion-interactive inline-flex h-10 items-center justify-center gap-2 rounded-full border px-3 text-xs font-semibold uppercase tracking-[0.14em] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                  props.generationMode === 'wireframe'
                    ? 'border-cyan-300/40 bg-cyan-400/15 text-cyan-50'
                    : 'border-white/10 text-slate-200 hover:border-white/20 hover:bg-white/5'
                }`}
                disabled={props.disabled && props.generationMode !== 'wireframe'}
                onClick={props.onToggleWireframeMode}
                type="button"
              >
                <svg
                  aria-hidden="true"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M4 9h16M9 20V9M12 13h5M12 16h3"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.5"
                  />
                </svg>
                Wireframe
              </button>

              <p className="text-xs text-slate-500">
                {props.submitting
                  ? 'The desktop bridge is preparing this turn before the reply starts streaming.'
                  : props.generationMode === 'image'
                  ? 'Enter starts the image job. Shift+Enter keeps writing. Attached images are used as references.'
                  : props.generationMode === 'video'
                    ? 'Enter starts the video job. Shift+Enter keeps writing. Attach one starting image for the Wan 2.2 workflow.'
                    : props.generationMode === 'wireframe'
                      ? 'Enter sends the wireframe brief. Shift+Enter keeps writing. Follow-up answers stay in this flow.'
                      : 'Enter sends. Shift+Enter keeps writing. Models choose tools and skills automatically when needed.'}
              </p>
            </div>

            {props.streaming ? (
              <button
                className="motion-interactive inline-flex h-12 shrink-0 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-500/10 px-5 text-sm font-semibold text-rose-100 transition hover:border-rose-300/30 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                disabled={!props.onStop}
                onClick={() => {
                  void props.onStop?.();
                }}
                type="button"
              >
                Stop
              </button>
            ) : (
              <button
                className="composer-submit-button motion-cta motion-interactive inline-flex h-12 shrink-0 items-center justify-center rounded-2xl px-5 text-sm font-semibold transition disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
                disabled={
                  props.submitDisabled ||
                  props.disabled ||
                  props.submitting ||
                  !props.prompt.trim()
                }
                type="submit"
              >
                {props.submitting
                  ? visibleSubmitLabel
                  : props.generationMode === 'image'
                    ? 'Generate'
                    : props.generationMode === 'video'
                      ? 'Render video'
                      : props.generationMode === 'wireframe'
                        ? 'Wireframe'
                        : props.editing
                      ? 'Resend'
                      : 'Send'}
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
