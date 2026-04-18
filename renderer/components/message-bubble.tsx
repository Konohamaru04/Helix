import { type ReactNode, useState } from 'react';
import type { StoredMessage } from '@bridge/ipc/contracts';
import { AttachmentCard } from '@renderer/components/attachment-card';
import { formatTimestamp } from '@renderer/lib/format';
import { parseAssistantContent } from '@renderer/lib/message-content';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MessageBubbleProps {
  message: StoredMessage;
  canEdit?: boolean;
  canRegenerate?: boolean;
  canPin?: boolean;
  onEdit?: (message: StoredMessage) => void;
  onRegenerate?: (message: StoredMessage) => void;
  onTogglePin?: (message: StoredMessage, pinned: boolean) => void;
}

function formatRouteStrategy(strategy: NonNullable<StoredMessage['routeTrace']>['strategy']) {
  switch (strategy) {
    case 'skill-chat':
      return 'Skill chat';
    case 'tool-chat':
      return 'Tool assisted';
    case 'rag-chat':
      return 'RAG chat';
    case 'rag-tool':
      return 'RAG + tool';
    case 'tool':
      return 'Direct tool';
    default:
      return 'Chat';
  }
}

function formatReason(value: string) {
  return value.replaceAll('-', ' ');
}

function MarkdownContent(props: { content: string }) {
  return (
    <div className="min-w-0 space-y-3 break-words text-sm leading-7 text-slate-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p(nodeProps) {
            return <p className="my-3 break-words" {...nodeProps} />;
          },
          ul(nodeProps) {
            return <ul className="my-3 list-disc pl-6" {...nodeProps} />;
          },
          ol(nodeProps) {
            return <ol className="my-3 list-decimal pl-6" {...nodeProps} />;
          },
          pre(nodeProps) {
            return (
              <pre
                className="my-3 max-w-full overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/90 p-4 text-sm leading-6 text-slate-100"
                {...nodeProps}
              />
            );
          },
          a(nodeProps) {
            return (
              <a
                className="text-cyan-300 underline"
                rel="noreferrer"
                target="_blank"
                {...nodeProps}
              />
            );
          },
          code(nodeProps) {
            const { className, children, ...rest } = nodeProps;
            const childText = Array.isArray(children)
              ? children
                  .filter((child): child is string => typeof child === 'string')
                  .join('')
              : typeof children === 'string'
                ? children
                : '';
            const isInline = !className && !childText.includes('\n');

            if (isInline) {
              return (
                <code
                  className="rounded bg-slate-950 px-1.5 py-0.5 text-cyan-200"
                  {...rest}
                >
                  {children}
                </code>
              );
            }

            return (
              <code
                className={`${className ?? ''} block min-w-max whitespace-pre`}
                {...rest}
              >
                {children}
              </code>
            );
          },
          table(nodeProps) {
            return (
              <div className="my-3 overflow-x-auto rounded-2xl border border-white/10">
                <table {...nodeProps} />
              </div>
            );
          },
          th(nodeProps) {
            return (
              <th
                className="border-b border-white/10 bg-slate-950/80 px-3 py-2 text-left text-xs uppercase tracking-[0.18em] text-slate-200"
                {...nodeProps}
              />
            );
          },
          td(nodeProps) {
            return (
              <td
                className="border-b border-white/5 px-3 py-2 align-top break-words text-slate-300"
                {...nodeProps}
              />
            );
          }
        }}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBlock(props: { content: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(props.defaultOpen));

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/10 bg-slate-950/70 px-4 py-2 transition-colors duration-150 hover:bg-slate-950/90">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-200/80">
          Thinking
        </p>
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200">
          {open ? (
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
          ) : (
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          )}
          {open ? 'Collapse' : 'Expand'}
        </span>
      </summary>
      <div className="whitespace-pre-wrap pb-2 pt-3 text-sm leading-7 text-slate-300">
        {props.content}
      </div>
    </details>
  );
}

function MetadataSection(props: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: string;
}) {
  const collapsible = Boolean(props.collapsible);
  const [open, setOpen] = useState(collapsible ? Boolean(props.defaultOpen) : true);

  if (collapsible) {
    return (
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/10 bg-slate-950/55 px-4 py-2 hover:bg-slate-950/80">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-200/75">
              {props.title}
            </p>
            {props.summary ? (
              <p className="mt-1 text-xs text-slate-400">{props.summary}</p>
            ) : null}
          </div>
          <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200">
            {open ? (
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
            ) : (
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
            )}
            {open ? 'Collapse' : 'Expand'}
          </span>
        </summary>
        <div className="mt-3">{props.children}</div>
      </details>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-cyan-200/75">
          {props.title}
        </p>
        {props.summary ? (
          <p className="text-xs text-slate-400">{props.summary}</p>
        ) : null}
      </div>
      <div className="mt-3">{props.children}</div>
    </section>
  );
}

function ToolInvocationCard(props: {
  invocation: NonNullable<StoredMessage['toolInvocations']>[number];
}) {
  const { invocation } = props;
  const hasDetailedOutput = Boolean(invocation.outputText?.trim());
  const [open, setOpen] = useState(false);

  return (
    <details open={open} onToggle={(e) => { e.stopPropagation(); setOpen((e.target as HTMLDetailsElement).open); }}>
      <summary onClick={(e) => e.stopPropagation()} className="flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 hover:bg-white/[0.06]">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-slate-100">{invocation.displayName}</p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${
              invocation.status === 'completed'
                ? 'bg-emerald-400/15 text-emerald-200'
                : 'bg-rose-400/15 text-rose-200'
            }`}
          >
            {invocation.status}
          </span>
        </div>
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">
          {open ? (
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
          ) : (
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          )}
          {open ? 'Collapse' : 'Expand'}
        </span>
      </summary>
      <div className="px-3 pb-2 pt-1">
        <p className="text-xs text-slate-400">Input: {invocation.inputSummary}</p>
        {invocation.outputSummary ? (
          <p className="mt-1 text-xs text-slate-300">Output: {invocation.outputSummary}</p>
        ) : null}
        {invocation.errorMessage ? (
          <p className="mt-1 text-xs text-rose-200">Error: {invocation.errorMessage}</p>
        ) : null}
      </div>
      {invocation.outputText ? (
        <div className="border-t border-white/5 px-3 py-3">
          <MarkdownContent content={invocation.outputText} />
        </div>
      ) : null}
    </details>
  );
}

export function MessageBubble(props: MessageBubbleProps) {
  const { message } = props;
  const assistant = message.role === 'assistant';
  const parsedAssistantContent = assistant ? parseAssistantContent(message.content) : null;
  const assistantAnswer = parsedAssistantContent?.answer ?? '';
  const thinkingBlocks = parsedAssistantContent?.thinkingBlocks ?? [];
  const activeToolCount = message.toolInvocations?.length ?? 0;

  return (
    <article
      className={`animate-fade-in-up min-w-0 overflow-hidden ${
        assistant
          ? 'text-slate-100'
          : message.role === 'user'
            ? 'rounded-[1.75rem] border border-orange-300/20 bg-orange-500/10 px-5 py-4 shadow-panel text-orange-50'
            : 'rounded-[1.75rem] border border-white/10 bg-slate-950/90 px-5 py-4 shadow-panel text-slate-200'
      }`}
    >
      <div className={`flex items-start justify-between gap-4 ${assistant ? 'py-2' : ''}`}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
              {message.role}
            </p>
            {message.pinned ? (
              <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-cyan-100">
                Pinned
              </span>
            ) : null}
            {message.routeTrace ? (
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200">
                {formatRouteStrategy(message.routeTrace.strategy)}
              </span>
            ) : null}
            {props.canPin && props.onTogglePin ? (
              <button
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onClick={() => props.onTogglePin?.(message, !message.pinned)}
                type="button"
              >
                {message.pinned ? 'Unpin' : 'Pin'}
              </button>
            ) : null}
            {props.canEdit && props.onEdit ? (
              <button
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onClick={() => props.onEdit?.(message)}
                type="button"
              >
                Edit & resend
              </button>
            ) : null}
            {props.canRegenerate && props.onRegenerate ? (
              <button
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
                onClick={() => props.onRegenerate?.(message)}
                type="button"
              >
                {message.status === 'failed' ? 'Retry response' : 'Regenerate'}
              </button>
            ) : null}
          </div>

          {message.attachments.length > 0 ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {message.attachments.map((attachment) => (
                <AttachmentCard
                  key={attachment.id}
                  attachment={attachment}
                />
              ))}
            </div>
          ) : null}

          {assistant ? (
            <div className="mt-3 space-y-3">
              {thinkingBlocks.map((thinking, index) => (
                <ThinkingBlock
                  key={`${message.id}-thinking-${index}-${message.status}-${assistantAnswer ? 'answer' : 'pending'}`}
                  content={thinking}
                  defaultOpen={message.status === 'streaming' && !assistantAnswer}
                />
              ))}

              {assistantAnswer ? (
                <MarkdownContent content={assistantAnswer} />
              ) : message.status === 'streaming' ? (
                <div className="rounded-lg border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                  {activeToolCount > 0
                    ? `Working through ${activeToolCount} tool step${activeToolCount === 1 ? '' : 's'}...`
                    : 'Thinking...'}
                </div>
              ) : message.status === 'completed' ? (
                <div className="rounded-lg border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                  No visible answer was returned for this turn.
                </div>
              ) : null}

              {message.toolInvocations?.length ? (
                <MetadataSection
                  title="Tools"
                  collapsible
                  defaultOpen={false}
                  summary={`${activeToolCount} tool${activeToolCount === 1 ? '' : 's'}`}
                >
                  <div className="space-y-3">
                    {message.toolInvocations.map((invocation) => (
                      <ToolInvocationCard
                        key={invocation.id}
                        invocation={invocation}
                      />
                    ))}
                  </div>
                </MetadataSection>
              ) : null}

              {message.contextSources?.length ? (
                <MetadataSection
                  title="Sources"
                  collapsible
                  defaultOpen={false}
                  summary={`${message.contextSources.length} source${
                    message.contextSources.length === 1 ? '' : 's'
                  }`}
                >
                  <div className="space-y-3">
                    {message.contextSources.map((source) => (
                      <div
                        key={source.id}
                        className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-slate-100">{source.label}</p>
                          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-300">
                            {source.kind === 'pinned_message' ? 'Memory' : 'Knowledge'}
                          </span>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-300">
                          {source.excerpt}
                        </p>
                        {source.sourcePath ? (
                          <p className="mt-2 break-all text-[11px] text-slate-500">
                            {source.sourcePath}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </MetadataSection>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-7">{message.content}</p>
          )}

          {assistant && (message.routeTrace || message.usage || message.model) ? (
            <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-400">
              {message.model ? <span>Model: {message.model}</span> : null}
              {message.routeTrace ? (
                <span>
                  Route: {formatRouteStrategy(message.routeTrace.strategy)} via{' '}
                  {formatReason(message.routeTrace.reason)}
                </span>
              ) : null}
              {message.routeTrace?.fallbackModel ? (
                <span>Fallback from: {message.routeTrace.fallbackModel}</span>
              ) : null}
              {message.routeTrace?.activeSkillId ? (
                <span>Skill: @{message.routeTrace.activeSkillId}</span>
              ) : null}
              {message.routeTrace?.activeToolId ? (
                <span>Tool: {message.routeTrace.activeToolId}</span>
              ) : null}
              {message.usage ? (
                <span>
                  Tokens: {message.usage.promptTokens} in / {message.usage.completionTokens} out
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 text-right text-xs text-slate-500">
          <p>{formatTimestamp(message.createdAt)}</p>
          <p className="mt-1 capitalize">{message.status}</p>
        </div>
      </div>
    </article>
  );
}
