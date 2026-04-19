import { useEffect, useMemo, useState } from 'react';
import type { AgentMessage, AgentSession, TeamSession } from '@bridge/ipc/contracts';
import { formatTimestamp } from '@renderer/lib/format';

interface AgentsDrawerProps {
  open: boolean;
  agents: AgentSession[];
  teams: TeamSession[];
  onClose?: (() => void) | undefined;
}

function statusBadgeClass(status: AgentSession['status']) {
  switch (status) {
    case 'running':
      return 'bg-cyan-400/15 text-cyan-100';
    case 'completed':
      return 'bg-emerald-400/15 text-emerald-200';
    case 'failed':
      return 'bg-rose-400/15 text-rose-200';
    case 'stopped':
      return 'bg-amber-400/15 text-amber-200';
    default:
      return 'bg-slate-400/15 text-slate-300';
  }
}

function statusLabel(status: AgentSession['status']) {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Idle';
  }
}

function roleBadgeClass(role: AgentMessage['role']) {
  switch (role) {
    case 'assistant':
      return 'bg-cyan-400/15 text-cyan-100';
    case 'user':
      return 'bg-emerald-400/15 text-emerald-200';
    default:
      return 'bg-slate-400/15 text-slate-300';
  }
}

function getSessionActivityAt(session: AgentSession) {
  return session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
}

function getSessionPreview(session: AgentSession) {
  const lastMessage = session.messages.at(-1)?.content.trim();

  if (lastMessage) {
    return lastMessage;
  }

  const systemPrompt = session.systemPrompt?.trim();
  return systemPrompt || 'No transcript yet.';
}

function SessionCard(props: {
  session: AgentSession;
  teamName: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-label={`Open agent ${props.session.title}`}
      aria-pressed={props.selected}
      className={`w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
        props.selected
          ? 'border-cyan-300/30 bg-cyan-400/10'
          : 'border-white/10 bg-slate-950/45 hover:border-white/20 hover:bg-white/5'
      }`}
      onClick={props.onSelect}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-100">{props.session.title}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${statusBadgeClass(props.session.status)}`}
            >
              {statusLabel(props.session.status)}
            </span>
            {props.teamName ? (
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-300">
                {props.teamName}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">{getSessionPreview(props.session)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] text-slate-500">{formatTimestamp(getSessionActivityAt(props.session))}</p>
          <p className="mt-2 text-[11px] text-slate-500">
            {props.session.messages.length} message{props.session.messages.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>
    </button>
  );
}

export function AgentsDrawer(props: AgentsDrawerProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sortedAgents = useMemo(
    () =>
      [...props.agents].sort(
        (left, right) =>
          new Date(getSessionActivityAt(right)).getTime() -
          new Date(getSessionActivityAt(left)).getTime()
      ),
    [props.agents]
  );

  const teamsById = useMemo(
    () => new Map(props.teams.map((team) => [team.id, team])),
    [props.teams]
  );

  useEffect(() => {
    if (!props.open) {
      setSelectedSessionId(null);
      return;
    }

    if (sortedAgents.length === 0) {
      setSelectedSessionId(null);
      return;
    }

    if (!selectedSessionId || !sortedAgents.some((session) => session.id === selectedSessionId)) {
      const firstSession = sortedAgents[0];

      if (firstSession) {
        setSelectedSessionId(firstSession.id);
      }
    }
  }, [props.open, selectedSessionId, sortedAgents]);

  if (!props.open) {
    return null;
  }

  const selectedSession =
    sortedAgents.find((session) => session.id === selectedSessionId) ?? sortedAgents[0] ?? null;
  const selectedTeam =
    selectedSession?.teamId ? teamsById.get(selectedSession.teamId) ?? null : null;
  const runningCount = props.agents.filter((session) => session.status === 'running').length;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-6 animate-fade-in">
      <section className="pointer-events-auto flex max-h-[calc(76vh-2rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur animate-slide-in-up">
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">Agents</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Agent sessions</h2>
            <p className="mt-3 max-w-3xl text-sm text-slate-400">
              Review background agent runs, inspect their transcript, and verify whether a session
              completed, failed, or is still running.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-300">
              <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                Sessions {props.agents.length}
              </span>
              <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                Running {runningCount}
              </span>
              <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1">
                Teams {props.teams.length}
              </span>
            </div>
          </div>
          {props.onClose ? (
            <button
              aria-label="Close agents drawer"
              className="mt-1 shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
              onClick={props.onClose}
              type="button"
            >
              Close
            </button>
          ) : null}
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
            <section className="space-y-3 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-100">Sessions</h3>
                <span className="text-xs text-slate-400">{sortedAgents.length}</span>
              </div>

              {sortedAgents.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                  No agent sessions yet. Agent runs created by the tool surface will appear here.
                </p>
              ) : (
                <div className="space-y-2">
                  {sortedAgents.map((session) => (
                    <SessionCard
                      key={session.id}
                      onSelect={() => setSelectedSessionId(session.id)}
                      selected={selectedSession?.id === session.id}
                      session={session}
                      teamName={session.teamId ? teamsById.get(session.teamId)?.title ?? null : null}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-4 rounded-[1.5rem] border border-white/10 bg-slate-900/60 px-4 py-4">
              {selectedSession ? (
                <>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-semibold text-white">{selectedSession.title}</h3>
                      <span
                        className={`rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${statusBadgeClass(selectedSession.status)}`}
                      >
                        {statusLabel(selectedSession.status)}
                      </span>
                      {selectedTeam ? (
                        <span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-300">
                          Team {selectedTeam.title}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 space-y-1 text-xs text-slate-500">
                      <p className="font-mono">Agent ID: {selectedSession.id}</p>
                      {selectedSession.parentConversationId ? (
                        <p className="font-mono">
                          Parent chat: {selectedSession.parentConversationId}
                        </p>
                      ) : null}
                      <p>
                        Created {formatTimestamp(selectedSession.createdAt)}
                        {selectedSession.lastMessageAt
                          ? ` · Last activity ${formatTimestamp(selectedSession.lastMessageAt)}`
                          : ''}
                      </p>
                    </div>
                  </div>

                  {selectedSession.systemPrompt ? (
                    <div className="rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">
                        System prompt
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                        {selectedSession.systemPrompt}
                      </p>
                    </div>
                  ) : null}

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="text-sm font-semibold text-slate-100">Transcript</h4>
                      <span className="text-xs text-slate-400">
                        {selectedSession.messages.length} message
                        {selectedSession.messages.length === 1 ? '' : 's'}
                      </span>
                    </div>

                    {selectedSession.messages.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                        This session has no messages yet.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {selectedSession.messages.map((message) => (
                          <article
                            key={message.id}
                            className="rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] ${roleBadgeClass(message.role)}`}
                              >
                                {message.role}
                              </span>
                              <span className="text-[11px] text-slate-500">
                                {formatTimestamp(message.createdAt)}
                              </span>
                            </div>
                            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                              {message.content}
                            </p>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-400">
                  Select an agent session to inspect its transcript.
                </p>
              )}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
