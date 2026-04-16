import { useEffect, useMemo, useRef } from 'react';
import type { GenerationJob, StoredMessage } from '@bridge/ipc/contracts';
import { GenerationThreadItem } from '@renderer/components/generation-thread-item';
import { MessageBubble } from '@renderer/components/message-bubble';

interface MessageListProps {
  conversationTitle: string;
  messages: StoredMessage[];
  generationJobs?: GenerationJob[];
  pendingLabel?: string | null;
  pendingHint?: string | null;
  onEditMessage?: (message: StoredMessage) => void;
  onRegenerateMessage?: (message: StoredMessage) => void;
  onTogglePin?: (message: StoredMessage, pinned: boolean) => void;
  onCancelGenerationJob?: (jobId: string) => void;
  onRetryGenerationJob?: (jobId: string) => void;
  streaming: boolean;
}

const AUTO_SCROLL_THRESHOLD_PX = 96;

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

  useEffect(() => {
    followOutputRef.current = true;
  }, [conversationKey]);

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
        className="rounded-[1.75rem] border border-cyan-300/15 bg-cyan-400/5 px-5 py-4 shadow-panel"
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
            </p>
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
      {timelineItems.length === 0 ? (
        pendingTurnIndicator ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col justify-center">
            {pendingTurnIndicator}
          </div>
        ) : (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center rounded-[2rem] border border-dashed border-white/10 bg-slate-900/40 px-10 py-14 text-center shadow-panel">
            <p className="text-sm uppercase tracking-[0.3em] text-cyan-200/70">
              Local-first chat
            </p>
            <h2 className="mt-4 text-4xl font-semibold text-white">
              Start a local conversation
            </h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-slate-300">
              Workspaces, knowledge import, routing, tools, and pinned memory all
              come alive once you send the first message in this workspace.
            </p>
          </div>
        )
      ) : (
        <div className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-5">
          {timelineItems.map((item) => {
            if (item.type === 'generation') {
              return (
                <GenerationThreadItem
                  key={`generation-${item.job.id}`}
                  job={item.job}
                  {...(props.onCancelGenerationJob
                    ? { onCancel: props.onCancelGenerationJob }
                    : {})}
                  {...(props.onRetryGenerationJob
                    ? { onRetry: props.onRetryGenerationJob }
                    : {})}
                />
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
              <MessageBubble
                key={message.id}
                canEdit={canEdit}
                canPin={!props.streaming && message.status === 'completed'}
                canRegenerate={canRegenerate}
                message={message}
                {...(props.onEditMessage ? { onEdit: props.onEditMessage } : {})}
                {...(props.onTogglePin ? { onTogglePin: props.onTogglePin } : {})}
                {...(props.onRegenerateMessage
                  ? { onRegenerate: props.onRegenerateMessage }
                  : {})}
              />
            );
          })}

          {pendingTurnIndicator}
        </div>
      )}
    </section>
  );
}
