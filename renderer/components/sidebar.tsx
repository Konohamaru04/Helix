import type {
  ConversationSearchResult,
  ConversationSummary,
  WorkspaceSummary
} from '@bridge/ipc/contracts';
import { APP_COMPANY_NAME, APP_DISPLAY_NAME } from '@bridge/branding';

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
  overlayMode?: boolean;
  onClose?: () => void;
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

export function Sidebar(props: SidebarProps) {
  const conversationsByWorkspace = props.workspaces.map((workspace) => ({
    workspace,
    conversations: props.conversations.filter(
      (conversation) => conversation.workspaceId === workspace.id
    )
  }));
  const unassignedConversations = props.conversations.filter(
    (conversation) => conversation.workspaceId === null
  );

  return (
    <aside className={`flex w-80 shrink-0 flex-col border-r border-white/10 bg-slate-950/80 backdrop-blur${props.overlayMode ? ' h-full' : ''}`}>
      {props.overlayMode ? (
        <div className="flex items-center justify-end px-5 pt-3">
          <button
            aria-label="Close sidebar"
            className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
            onClick={props.onClose}
            type="button"
          >
            Close
          </button>
        </div>
      ) : null}
      <div className="border-b border-white/10 px-5 py-4">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-200/70">
          {APP_COMPANY_NAME}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-white">{APP_DISPLAY_NAME}</h1>
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
          <button
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
              props.activeWorkspaceId === null
                ? 'bg-cyan-400 text-slate-950'
                : 'border border-white/10 text-slate-300 hover:border-white/20 hover:bg-white/5'
            }`}
            onClick={() => props.onSelectWorkspace(null)}
            type="button"
          >
            All
          </button>
          {props.workspaces.map((workspace) => (
            <div key={workspace.id} className="group relative flex items-center">
              <button
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                  workspace.id === props.activeWorkspaceId
                    ? 'bg-cyan-400 pr-6 text-slate-950'
                    : 'border border-white/10 pr-6 text-slate-300 hover:border-white/20 hover:bg-white/5'
                }`}
                onClick={() => props.onSelectWorkspace(workspace.id)}
                type="button"
              >
                {workspace.name}
              </button>
              <button
                aria-label={`Delete workspace ${workspace.name}`}
                className={`absolute right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 ${
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {props.searchQuery.trim() ? (
          <>
            <p className="px-2 pb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
              Search results
            </p>
            <div className="space-y-2">
              {props.searchResults.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                  No chats matched your search.
                </div>
              ) : null}

              {props.searchResults.map((result) => {
                const active = result.conversation.id === props.activeConversationId;

                return (
                  <button
                    key={result.conversation.id}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                      active
                        ? 'border-cyan-300/40 bg-cyan-400/10 text-white'
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
                );
              })}
            </div>
          </>
        ) : (
          <div className="space-y-5">
            {props.activeWorkspaceId === null && unassignedConversations.length > 0 ? (
              <div>
                <p className="px-2 pb-2 text-xs uppercase tracking-[0.2em] text-slate-500">
                  Unassigned
                </p>
                <div className="space-y-2">
                  {unassignedConversations.map((conversation) => {
                    const active = conversation.id === props.activeConversationId;

                    return (
                      <button
                        key={conversation.id}
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                          active
                            ? 'border-cyan-300/40 bg-cyan-400/10 text-white'
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
                    <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                      No chats in this workspace yet.
                    </div>
                  ) : null}

                  {group.conversations.map((conversation) => {
                    const active = conversation.id === props.activeConversationId;

                    return (
                      <button
                        key={conversation.id}
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 ${
                          active
                            ? 'border-cyan-300/40 bg-cyan-400/10 text-white'
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
                    );
                  })}
                </div>
              </div>
            ))}

            {props.conversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
                Your first chat will appear here once you send a message.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
