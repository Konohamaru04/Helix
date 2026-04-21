import { useState, type MouseEvent } from 'react';
import type {
  ConversationSearchResult,
  ConversationSummary,
  WorkspaceSummary
} from '@bridge/ipc/contracts';
import { APP_COMPANY_NAME, APP_DISPLAY_NAME } from '@bridge/branding';
import { ContextMenu, type ContextMenuItem } from '@renderer/components/context-menu';

interface SidebarProps {
  workspaces: WorkspaceSummary[];
  conversations: ConversationSummary[];
  searchQuery: string;
  searchResults: ConversationSearchResult[];
  activeWorkspaceId: string | null;
  activeConversationId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
  onSelectConversation: (conversationId: string) => void;
  onSearchQueryChange: (query: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onSetWorkspaceFolder?: (workspaceId: string) => void;
  onClearWorkspaceFolder?: (workspaceId: string) => void;
  onNewChat: () => void;
  onNewWorkspace: () => void;
  onDeleteConversation?: (conversationId: string) => void;
  overlayMode?: boolean;
  onClose?: () => void;
}

type SidebarContextMenuState =
  | {
      kind: 'workspace';
      workspace: WorkspaceSummary;
      x: number;
      y: number;
    }
  | {
      kind: 'conversation';
      conversation: ConversationSummary;
      x: number;
      y: number;
    };

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function Sidebar(props: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const conversationsByWorkspace = props.workspaces.map((workspace) => ({
    workspace,
    conversations: props.conversations.filter(
      (conversation) => conversation.workspaceId === workspace.id
    )
  }));
  const unassignedConversations = props.conversations.filter(
    (conversation) => conversation.workspaceId === null
  );
  const contextMenuItems: ContextMenuItem[] =
    contextMenu?.kind === 'workspace'
      ? [
          {
            key: 'open-workspace',
            label: 'Open workspace',
            onSelect: () => props.onSelectWorkspace(contextMenu.workspace.id)
          },
          {
            key: 'set-workspace-folder',
            label: contextMenu.workspace.rootPath ? 'Change folder' : 'Connect folder',
            onSelect: () => props.onSetWorkspaceFolder?.(contextMenu.workspace.id),
            disabled: !props.onSetWorkspaceFolder
          },
          ...(contextMenu.workspace.rootPath && props.onClearWorkspaceFolder
            ? [
                {
                  key: 'clear-workspace-folder',
                  label: 'Disconnect folder',
                  onSelect: () => props.onClearWorkspaceFolder?.(contextMenu.workspace.id)
                }
              ]
            : []),
          {
            key: 'delete-workspace',
            label: 'Delete workspace',
            danger: true,
            onSelect: () => {
              if (
                window.confirm(
                  `Delete workspace "${contextMenu.workspace.name}"? Conversations will be unassigned.`
                )
              ) {
                props.onDeleteWorkspace(contextMenu.workspace.id);
              }
            }
          }
        ]
      : contextMenu?.kind === 'conversation'
        ? [
            {
              key: 'open-chat',
              label: 'Open chat',
              onSelect: () => props.onSelectConversation(contextMenu.conversation.id)
            },
            ...(props.onDeleteConversation
              ? [
                  {
                    key: 'delete-chat',
                    label: 'Delete chat',
                    danger: true,
                    onSelect: () =>
                      props.onDeleteConversation?.(contextMenu.conversation.id)
                  }
                ]
              : [])
          ]
        : [];

  function openWorkspaceContextMenu(
    event: MouseEvent<HTMLElement>,
    workspace: WorkspaceSummary
  ) {
    event.preventDefault();
    setContextMenu({
      kind: 'workspace',
      workspace,
      x: event.clientX,
      y: event.clientY
    });
  }

  function openConversationContextMenu(
    event: MouseEvent<HTMLElement>,
    conversation: ConversationSummary
  ) {
    event.preventDefault();
    setContextMenu({
      kind: 'conversation',
      conversation,
      x: event.clientX,
      y: event.clientY
    });
  }

  return (
    <aside className="motion-panel flex h-full w-80 shrink-0 flex-col border-r border-white/10 bg-slate-950/80 backdrop-blur">
      {props.overlayMode ? (
        <div className="flex items-center justify-end px-5 pt-3">
          <button
            aria-label="Close sidebar"
            className="motion-interactive rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            onClick={props.onClose}
            type="button"
          >
            Close
          </button>
        </div>
      ) : null}
      <div className="border-b border-white/10 px-5 py-4">
        <p className="motion-text-reveal text-xs uppercase tracking-[0.3em] text-cyan-200/70">
          {APP_COMPANY_NAME}
        </p>
        <h1 className="motion-text-reveal-delayed motion-title-glint mt-2 text-2xl font-semibold">{APP_DISPLAY_NAME}</h1>
        <p className="mt-2 text-xs uppercase tracking-[0.25em] text-slate-500">
          Chats
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Track workspaces and jump between conversations.
        </p>
      </div>

      <div className="border-b border-white/10 px-5 py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
          Workspaces
        </p>
        <div className="flex flex-wrap gap-2">
          {props.workspaces.map((workspace) => (
            <div
              key={workspace.id}
              className="group relative flex items-center"
              onContextMenu={(event) => openWorkspaceContextMenu(event, workspace)}
            >
              <button
                className={`motion-interactive rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                  workspace.id === props.activeWorkspaceId
                    ? 'motion-active-rail bg-cyan-400 pr-6 text-slate-950'
                    : 'border border-white/10 pr-6 text-slate-300 hover:border-white/20 hover:bg-white/5'
                }`}
                onClick={() => props.onSelectWorkspace(workspace.id)}
                type="button"
              >
                {workspace.name}
              </button>
              <button
                aria-label={`Delete workspace ${workspace.name}`}
                className={`motion-interactive absolute right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
                  workspace.id === props.activeWorkspaceId
                    ? 'text-slate-700 hover:bg-slate-950/20 hover:text-slate-900'
                    : 'text-slate-500 hover:bg-white/10 hover:text-slate-200'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete workspace "${workspace.name}"? Conversations will be unassigned.`)) {
                    props.onDeleteWorkspace(workspace.id);
                  }
                }}
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          className="motion-interactive mt-2 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
          onClick={props.onNewWorkspace}
          type="button"
        >
          + Workspace
        </button>
      </div>

      <div className="px-5 py-4">
        <label
          className="mb-2 block text-xs font-medium uppercase tracking-[0.2em] text-slate-400"
          htmlFor="chat-search"
        >
          Search
        </label>
        <input
          id="chat-search"
          aria-label="Search conversations"
          className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
          onChange={(event) => props.onSearchQueryChange(event.target.value)}
          placeholder="Search titles and message content"
          type="search"
          value={props.searchQuery}
        />
        <button
          className="motion-interactive mt-2 w-full rounded-xl bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          onClick={props.onNewChat}
          type="button"
        >
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {props.searchQuery.trim() ? (
          <>
            <p className="px-2 pb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
              Search results
            </p>
            <div className="space-y-2">
              {props.searchResults.length === 0 ? (
                  <div className="motion-panel rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                  No chats matched your search.
                </div>
              ) : null}

              {props.searchResults.map((result) => {
                const active = result.conversation.id === props.activeConversationId;

                return (
                  <div
                    key={result.conversation.id}
                    className="group relative"
                    onContextMenu={(event) =>
                      openConversationContextMenu(event, result.conversation)
                    }
                  >
                    <button
                      className={`motion-card w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                        active
                          ? 'motion-active-rail border-cyan-300/40 bg-cyan-400/10 pr-8 text-white'
                          : 'border-white/10 bg-slate-900/60 text-slate-300 hover:border-white/20 hover:bg-slate-900'
                      }`}
                      onClick={() => props.onSelectConversation(result.conversation.id)}
                      type="button"
                    >
                      <p className="truncate text-sm font-medium">
                        {result.conversation.title}
                      </p>
                      <p className="mt-1 text-xs text-cyan-200/70">
                        {result.workspaceName ?? 'Unassigned'}
                      </p>
                      {result.snippet ? (
                        <p className="mt-2 line-clamp-2 text-xs text-slate-400">
                          {result.snippet}
                        </p>
                      ) : null}
                    </button>
                    {active && props.onDeleteConversation ? (
                      <button
                        aria-label="Delete chat"
                        className="motion-interactive absolute right-2 top-3 flex h-5 w-5 items-center justify-center rounded-full text-xs text-rose-300 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onDeleteConversation?.(result.conversation.id);
                        }}
                        type="button"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="space-y-5">
            {unassignedConversations.length > 0 ? (
              <div>
                <p className="px-2 pb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
                  Unassigned
                </p>
                <div className="space-y-2">
                  {unassignedConversations.map((conversation) => {
                    const active = conversation.id === props.activeConversationId;

                    return (
                      <div
                        key={conversation.id}
                        className="group relative"
                        onContextMenu={(event) =>
                          openConversationContextMenu(event, conversation)
                        }
                      >
                        <button
                          className={`motion-card w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                            active
                              ? 'motion-active-rail border-cyan-300/40 bg-cyan-400/10 pr-8 text-white'
                              : 'border-white/10 bg-slate-900/60 text-slate-300 hover:border-white/20 hover:bg-slate-900'
                          }`}
                          onClick={() => props.onSelectConversation(conversation.id)}
                          type="button"
                        >
                          <p className="truncate text-sm font-medium">{conversation.title}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            Updated {formatTimestamp(conversation.updatedAt)}
                          </p>
                        </button>
                        {active && props.onDeleteConversation ? (
                          <button
                            aria-label="Delete chat"
                            className="motion-interactive absolute right-2 top-3 flex h-5 w-5 items-center justify-center rounded-full text-xs text-rose-300 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onDeleteConversation?.(conversation.id);
                            }}
                            type="button"
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {(props.activeWorkspaceId === null
              ? conversationsByWorkspace
              : conversationsByWorkspace.filter(
                  (group) => group.workspace.id === props.activeWorkspaceId
                )
            ).map((group) => (
              <div key={group.workspace.id}>
                <p className="px-2 pb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
                  {group.workspace.name}
                </p>
                <div className="space-y-2">
                  {group.conversations.length === 0 ? (
                    <div className="motion-panel rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                      No chats in this workspace yet.
                    </div>
                  ) : null}

                  {group.conversations.map((conversation) => {
                    const active = conversation.id === props.activeConversationId;

                    return (
                      <div
                        key={conversation.id}
                        className="group relative"
                        onContextMenu={(event) =>
                          openConversationContextMenu(event, conversation)
                        }
                      >
                        <button
                          className={`motion-card w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                            active
                              ? 'motion-active-rail border-cyan-300/40 bg-cyan-400/10 pr-8 text-white'
                              : 'border-white/10 bg-slate-900/60 text-slate-300 hover:border-white/20 hover:bg-slate-900'
                          }`}
                          onClick={() => props.onSelectConversation(conversation.id)}
                          type="button"
                        >
                          <p className="truncate text-sm font-medium">{conversation.title}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            Updated {formatTimestamp(conversation.updatedAt)}
                          </p>
                        </button>
                        {active && props.onDeleteConversation ? (
                          <button
                            aria-label="Delete chat"
                            className="motion-interactive absolute right-2 top-3 flex h-5 w-5 items-center justify-center rounded-full text-xs text-rose-300 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onDeleteConversation?.(conversation.id);
                            }}
                            type="button"
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {props.conversations.length === 0 ? (
              <div className="motion-panel rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                Your first chat will appear here once you send a message.
              </div>
            ) : null}
          </div>
        )}
      </div>
      {contextMenu ? (
        <ContextMenu
          items={contextMenuItems}
          label={contextMenu.kind === 'workspace' ? 'Workspace actions' : 'Chat actions'}
          onClose={() => setContextMenu(null)}
          x={contextMenu.x}
          y={contextMenu.y}
        />
      ) : null}
    </aside>
  );
}
