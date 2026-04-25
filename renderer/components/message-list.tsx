import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerationJob, StoredMessage } from '@bridge/ipc/contracts';
import { GenerationThreadItem } from '@renderer/components/generation-thread-item';
import { MessageBubble } from '@renderer/components/message-bubble';
import { WireframePreviewPanel } from '@renderer/components/wireframe-preview-panel';
import type { WireframeDesignIteration } from '@renderer/lib/wireframe';

interface MessageListProps {
  conversationTitle: string;
  messages: StoredMessage[];
  generationJobs?: GenerationJob[];
  pendingLabel?: string | null;
  pendingHint?: string | null;
  onEditMessage?: (message: StoredMessage) => void;
  onRegenerateMessage?: (message: StoredMessage) => void;
  onTogglePin?: (message: StoredMessage, pinned: boolean) => void;
  onLoadMessageArtifacts?: (messageId: string) => void;
  onCancelGenerationJob?: (jobId: string) => void;
  onRetryGenerationJob?: (jobId: string) => void;
  onSelectWireframeIteration?: (iterationId: string) => void;
  onSubmitWireframeAnswers?: (prompt: string) => Promise<void>;
  streaming: boolean;
  wireframeDesignIterations?: WireframeDesignIteration[];
  wireframeIntroVisible?: boolean;
  wireframeQuestionsMessageId?: string | null;
  wireframeSelectedIterationId?: string | null;
}

const AUTO_SCROLL_THRESHOLD_PX = 96;

const EMPTY_STATE_TIPS = [
  {
    eyebrow: 'Workspace tip',
    title: 'Bind a folder to this workspace',
    body: 'Link a local project folder from the composer actions so tools and imports stay scoped to the right files.'
  },
  {
    eyebrow: 'Knowledge tip',
    title: 'Import files for grounded answers',
    body: 'Text-like attachments and workspace imports become searchable context that can show up later in Sources.'
  },
  {
    eyebrow: 'Skills tip',
    title: 'Shape behavior with local skills',
    body: 'Open the Skills drawer from the status bar to create or edit reusable prompts that routing can pick up immediately.'
  },
  {
    eyebrow: 'Agents tip',
    title: 'Inspect background agent sessions',
    body: 'The Agents drawer shows sub-agent transcripts, current status, and team membership after agentic tool runs.'
  },
  {
    eyebrow: 'Memory tip',
    title: 'Pin messages that must stay in context',
    body: 'Important assistant messages can be pinned so follow-up turns keep key facts close without repeating yourself.'
  },
  {
    eyebrow: 'Queue tip',
    title: 'Track long-running work from Queue',
    body: 'Image and video jobs stream inline in chat and stay recoverable from the global queue drawer if you need to retry or inspect them.'
  },
  {
    eyebrow: 'Trace tip',
    title: 'Tools and Sources stay lightweight by default',
    body: 'Heavy tool traces and source excerpts load only when you expand a specific message, which keeps large chats responsive.'
  },
  {
    eyebrow: 'Routing tip',
    title: 'Leave the model on Auto for normal work',
    body: 'The bridge can route between general chat, coding, vision, grounded answers, and tool-assisted flows before the reply starts.'
  }
] as const;

function WireframeIntroMessage() {
  return (
    <div className="motion-message-assistant w-full self-start">
      <article className="motion-card animate-fade-in-up min-w-0 overflow-hidden text-slate-100">
        <div className="rounded-[1.25rem] border border-cyan-300/20 bg-cyan-400/5 px-5 py-4 shadow-panel">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/80">
            Wireframe mode
          </p>
          <h2 className="mt-3 text-lg font-semibold text-slate-100">
            Describe your idea in detail.
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
            Include the users, main screens, core actions, data that appears on each screen, and any visual constraints. I will ask multiple-choice follow-up questions, then generate an HTML/CSS/JS wireframe canvas here.
          </p>
        </div>
      </article>
    </div>
  );
}

function pickRandomTipIndex(previousIndex: number | null = null) {
  const nextIndex = Math.floor(Math.random() * EMPTY_STATE_TIPS.length);

  if (EMPTY_STATE_TIPS.length <= 1 || previousIndex === null || nextIndex !== previousIndex) {
    return nextIndex;
  }

  return (nextIndex + 1) % EMPTY_STATE_TIPS.length;
}

function scrollDistanceFromBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

export function MessageList(props: MessageListProps) {
  const transcriptRef = useRef<HTMLElement | null>(null);
  const followOutputRef = useRef(true);
  const conversationKey = props.messages[0]?.conversationId ?? props.conversationTitle;
  const timelineItems = useMemo(() => {
    const messageItems = props.messages.map((message, index) => ({
      type: 'message' as const,
      id: message.id,
      sequence: index,
      createdAt: new Date(message.createdAt).getTime(),
      updatedAt: new Date(message.updatedAt).getTime(),
      message
    }));
    const generationItems = (props.generationJobs ?? []).map((job, index) => ({
      type: 'generation' as const,
      id: job.id,
      sequence: index,
      createdAt: new Date(job.createdAt).getTime(),
      updatedAt: new Date(job.updatedAt).getTime(),
      job
    }));

    return [...messageItems, ...generationItems].sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }

      if (left.type !== right.type) {
        return left.type === 'message' ? -1 : 1;
      }

      return left.sequence - right.sequence;
    });
  }, [props.generationJobs, props.messages]);
  const emptyStateVisible =
    timelineItems.length === 0 && !props.pendingLabel && !props.wireframeIntroVisible;
  const [emptyTipIndex, setEmptyTipIndex] = useState(() => pickRandomTipIndex());
  const lastTipIndexRef = useRef<number>(emptyTipIndex);
  const visibleEmptyStateKeyRef = useRef<string | null>(
    emptyStateVisible ? conversationKey : null
  );
  const lastTimelineSignature = useMemo(() => {
    const lastItem = timelineItems.at(-1);

    if (!lastItem) {
      return 'empty';
    }

    if (lastItem.type === 'message') {
      return [
        lastItem.message.id,
        lastItem.message.status,
        lastItem.message.updatedAt,
        lastItem.message.content.length
      ].join(':');
    }

    return [
      lastItem.job.id,
      lastItem.job.status,
      lastItem.job.updatedAt,
      lastItem.job.progress,
      lastItem.job.artifacts.length
    ].join(':');
  }, [timelineItems]);
  const lastUserMessageId = [...props.messages]
    .reverse()
    .find((message) => message.role === 'user')?.id;
  const lastAssistantMessageId = [...props.messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.id;
  const emptyStateTip = EMPTY_STATE_TIPS[emptyTipIndex] ?? EMPTY_STATE_TIPS[0];

  useEffect(() => {
    followOutputRef.current = true;
  }, [conversationKey]);

  useEffect(() => {
    if (!emptyStateVisible) {
      visibleEmptyStateKeyRef.current = null;
      return;
    }

    if (visibleEmptyStateKeyRef.current === conversationKey) {
      return;
    }

    const nextTipIndex = pickRandomTipIndex(lastTipIndexRef.current);
    lastTipIndexRef.current = nextTipIndex;
    visibleEmptyStateKeyRef.current = conversationKey;
    setEmptyTipIndex(nextTipIndex);
  }, [conversationKey, emptyStateVisible]);

  useEffect(() => {
    const transcript = transcriptRef.current;

    if (!transcript || !followOutputRef.current) {
      return;
    }

    if (typeof transcript.scrollTo === 'function') {
      transcript.scrollTo({
        top: transcript.scrollHeight,
        behavior: 'auto'
      });
      return;
    }

    transcript.scrollTop = transcript.scrollHeight;
  }, [conversationKey, lastTimelineSignature, timelineItems.length]);

  const pendingTurnIndicator =
    props.pendingLabel ? (
      <div
        aria-live="polite"
        className="motion-loader-sweep motion-panel rounded-[1.75rem] border border-cyan-300/15 bg-cyan-400/5 px-5 py-4 shadow-panel"
        role="status"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-cyan-200/25 border-t-cyan-200 motion-reduce:animate-none motion-safe:animate-spin"
          />
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/80">
              Preparing turn
            </p>
            <p className="mt-2 text-sm font-medium text-cyan-50">{props.pendingLabel}</p>
            <p className="mt-1 text-sm leading-6 text-cyan-100/70">
              {props.pendingHint ??
                'The bridge is analyzing the request and choosing the best route before the reply starts.'}
              <span className="motion-ellipsis" />
            </p>
            <div
              aria-hidden="true"
              className="motion-loader-bars mt-3 w-64 max-w-full"
            />
          </div>
        </div>
      </div>
    ) : null;

  return (
    <section
      ref={transcriptRef}
      aria-label="Conversation transcript"
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-6 sm:px-6"
      onScroll={(event) => {
        followOutputRef.current =
          scrollDistanceFromBottom(event.currentTarget) <= AUTO_SCROLL_THRESHOLD_PX
      }}
    >
      {timelineItems.length === 0 && !props.wireframeIntroVisible ? (
        pendingTurnIndicator ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col justify-center">
            {pendingTurnIndicator}
          </div>
        ) : (
          <div className="motion-panel mx-auto flex h-full max-w-2xl flex-col items-center justify-center rounded-[2rem] border border-dashed border-white/10 bg-slate-900/40 px-10 py-14 text-center shadow-panel">
            <p className="motion-text-reveal text-sm uppercase tracking-[0.3em] text-cyan-200/70">
              {emptyStateTip.eyebrow}
            </p>
            <h2 className="motion-text-reveal-delayed mt-4 text-4xl font-semibold text-white">
              {emptyStateTip.title}
            </h2>
            <p className="motion-panel-delayed mt-4 max-w-xl text-base leading-7 text-slate-300">
              {emptyStateTip.body}
            </p>
          </div>
        )
      ) : (
        <div className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-5">
          {props.wireframeIntroVisible ? <WireframeIntroMessage /> : null}

          {timelineItems.map((item, itemIndex) => {
            if (item.type === 'generation') {
              return (
                <div
                  className="motion-message-assistant"
                  key={`generation-${item.job.id}`}
                  style={{ animationDelay: `${Math.min(itemIndex, 8) * 35}ms` }}
                >
                  <GenerationThreadItem
                    job={item.job}
                    {...(props.onCancelGenerationJob
                      ? { onCancel: props.onCancelGenerationJob }
                      : {})}
                    {...(props.onRetryGenerationJob
                      ? { onRetry: props.onRetryGenerationJob }
                      : {})}
                  />
                </div>
              );
            }

            const message = item.message;
            const canEdit =
              !props.streaming &&
              message.role === 'user' &&
              message.id === lastUserMessageId &&
              Boolean(props.onEditMessage);
            const canRegenerate =
              !props.streaming &&
              message.role === 'assistant' &&
              message.id === lastAssistantMessageId &&
              Boolean(props.onRegenerateMessage);

            return (
              <div
                key={message.id}
                className={`${message.role === 'user' ? 'max-w-[80%] self-end motion-message-user' : 'w-full self-start motion-message-assistant'}`}
                style={{ animationDelay: `${Math.min(itemIndex, 8) * 35}ms` }}
              >
                <MessageBubble
                  canEdit={canEdit}
                  canPin={!props.streaming && message.status === 'completed'}
                  canRegenerate={canRegenerate}
                  message={message}
                  {...(props.onEditMessage ? { onEdit: props.onEditMessage } : {})}
                  {...(props.onLoadMessageArtifacts
                    ? { onLoadArtifacts: props.onLoadMessageArtifacts }
                    : {})}
                  {...(props.onSubmitWireframeAnswers
                    ? { onSubmitWireframeAnswers: props.onSubmitWireframeAnswers }
                    : {})}
                  {...(props.onTogglePin ? { onTogglePin: props.onTogglePin } : {})}
                  {...(props.onRegenerateMessage
                    ? { onRegenerate: props.onRegenerateMessage }
                    : {})}
                  wireframeQuestionsEnabled={
                    message.id === props.wireframeQuestionsMessageId
                  }
                />
              </div>
            );
          })}

          {pendingTurnIndicator}
          {props.wireframeDesignIterations &&
          props.wireframeDesignIterations.length > 0 ? (
            <WireframePreviewPanel
              iterations={props.wireframeDesignIterations}
              selectedIterationId={props.wireframeSelectedIterationId ?? null}
              {...(props.onSelectWireframeIteration
                ? { onSelectIteration: props.onSelectWireframeIteration }
                : {})}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
