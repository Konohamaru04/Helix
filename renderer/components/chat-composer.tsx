import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { MessageAttachment } from '@bridge/ipc/contracts';
import { APP_DISPLAY_NAME } from '@bridge/branding';
import { AttachmentCard } from '@renderer/components/attachment-card';

interface ChatComposerProps {
  disabled: boolean;
  editing: boolean;
  streaming: boolean;
  submitting?: boolean;
  submitLabel?: string | null;
  submitHint?: string | null;
  generationMode: boolean;
  imageGenerationAvailable: boolean;
  imageGenerationModelLabel: string | null;
  prompt: string;
  attachments: MessageAttachment[];
  activeWorkspaceName: string | null;
  workspaceRootPath: string | null;
  knowledgeDocumentCount: number;
  workspaceActionsEnabled: boolean;
  onPromptChange: (prompt: string) => void;
  onAttach: () => Promise<void>;
  onEnterImageMode: () => void;
  onExitImageMode: () => void;
  onConfigureWorkspaceFolder: () => Promise<void>;
  onImportWorkspaceKnowledge: () => Promise<void>;
  onDisconnectWorkspaceFolder: (() => Promise<void>) | undefined;
  onRemoveAttachment: (attachmentId: string) => void;
  onCancelEdit: () => void;
  onSubmit: () => Promise<void>;
  onStop?: () => Promise<void>;
}

type ComposerMenu = 'add' | 'workspace' | null;

export function ChatComposer(props: ChatComposerProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!props.prompt.trim() || props.disabled) {
      return;
    }

    setActiveMenu(null);
    await props.onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
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

  async function handleWorkspaceFolderClick() {
    setActiveMenu(null);
    await props.onConfigureWorkspaceFolder();
  }

  async function handleImportKnowledgeClick() {
    setActiveMenu(null);
    await props.onImportWorkspaceKnowledge();
  }

  async function handleDisconnectWorkspaceClick() {
    setActiveMenu(null);
    await props.onDisconnectWorkspaceFolder?.();
  }
  const visibleSubmitLabel =
    props.submitLabel ??
    (props.generationMode ? 'Generating...' : props.editing ? 'Resending...' : 'Sending...');

  return (
    <form
      aria-busy={props.submitting ? true : undefined}
      ref={formRef}
      className="border-t border-white/10 bg-slate-950/70 px-4 py-4 backdrop-blur sm:px-6"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="mx-auto flex max-w-[88rem] flex-col gap-3">
        {props.editing ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-cyan-400/20 bg-cyan-400/10 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-cyan-100/80">
                Editing
              </p>
              <p className="mt-1 text-sm text-cyan-50">
                Resend the updated message and replace the current reply chain.
              </p>
            </div>
            <button
              className="rounded-xl border border-cyan-100/20 px-3 py-1.5 text-xs font-medium text-cyan-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              onClick={props.onCancelEdit}
              type="button"
            >
              Cancel edit
            </button>
          </div>
        ) : null}

        {props.generationMode ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.5rem] border border-fuchsia-300/20 bg-fuchsia-500/10 px-4 py-3">
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
              className="rounded-xl border border-fuchsia-100/20 px-3 py-1.5 text-xs font-medium text-fuchsia-50 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-300"
              onClick={props.onExitImageMode}
              type="button"
            >
              Back to chat
            </button>
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

        <div className="rounded-[1.75rem] border border-white/10 bg-slate-900/70 p-3 shadow-panel">
          <textarea
            ref={textareaRef}
            id="chat-prompt"
            aria-label="Message prompt"
            className="h-28 w-full resize-none overflow-y-auto rounded-[1.35rem] border border-transparent bg-transparent px-3 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            disabled={props.disabled}
            onChange={(event) => props.onPromptChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              props.generationMode
                ? 'Describe the image you want to generate'
                : `Message ${APP_DISPLAY_NAME}`
            }
            rows={4}
            value={props.prompt}
          />

          {props.submitting ? (
            <div
              aria-live="polite"
              className="flex items-center gap-3 px-2 pb-1 text-sm text-cyan-100"
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
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-lg text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
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
                    className="absolute bottom-12 left-0 z-20 min-w-44 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
                    role="menu"
                  >
                    <button
                      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      onClick={() => {
                        void handleAttachClick();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      {props.generationMode ? 'Attach reference images' : 'Attach files'}
                    </button>
                    <button
                      className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                      disabled={!props.imageGenerationAvailable}
                      onClick={handleImageModeClick}
                      role="menuitem"
                      type="button"
                    >
                      Generate image
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="relative">
                <button
                  aria-expanded={activeMenu === 'workspace'}
                  aria-haspopup="menu"
                  aria-label="Open workspace settings"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 text-slate-200 transition hover:border-white/20 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
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
                    className="absolute bottom-12 left-0 z-20 min-w-64 rounded-2xl border border-white/10 bg-slate-950/95 p-2 shadow-panel backdrop-blur"
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
                          ? 'Project folder connected for relative tool paths.'
                          : 'Connect a folder and add docs without covering the transcript.'}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {props.knowledgeDocumentCount} knowledge document
                        {props.knowledgeDocumentCount === 1 ? '' : 's'}
                      </p>
                    </div>

                    <div className="space-y-1 pt-2">
                      <button
                        className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        onClick={() => {
                          void handleWorkspaceFolderClick();
                        }}
                        role="menuitem"
                        type="button"
                      >
                        {props.workspaceRootPath ? 'Change folder' : 'Connect folder'}
                      </button>
                      <button
                        className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-slate-100 transition hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                        onClick={() => {
                          void handleImportKnowledgeClick();
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Add docs
                      </button>
                      {props.workspaceRootPath && props.onDisconnectWorkspaceFolder ? (
                        <button
                          className="flex w-full items-center rounded-xl px-3 py-2 text-left text-sm text-rose-100 transition hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
                          onClick={() => {
                            void handleDisconnectWorkspaceClick();
                          }}
                          role="menuitem"
                          type="button"
                        >
                          Disconnect folder
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              <p className="text-xs text-slate-500">
                {props.submitting
                  ? 'The desktop bridge is preparing this turn before the reply starts streaming.'
                  : props.generationMode
                  ? 'Enter starts the image job. Shift+Enter keeps writing. Attached images are used as references.'
                  : 'Enter sends. Shift+Enter keeps writing. Models choose tools and skills automatically when needed.'}
              </p>
            </div>

            {props.streaming ? (
              <button
                className="inline-flex h-12 shrink-0 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-500/10 px-5 text-sm font-semibold text-rose-100 transition hover:border-rose-300/30 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300"
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
                className="inline-flex h-12 shrink-0 items-center justify-center rounded-2xl bg-orange-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-orange-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-300"
                disabled={props.disabled || props.submitting || !props.prompt.trim()}
                type="submit"
              >
                {props.submitting
                  ? visibleSubmitLabel
                  : props.generationMode
                    ? 'Generate'
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
