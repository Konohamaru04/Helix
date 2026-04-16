import type blessed from 'blessed';
import type { DesktopAppContext } from '@bridge/app-context';
import type { ChatStreamEvent } from '@bridge/ipc/contracts';
import { createChatInput } from '@tui/components/chat-input';
import { createMessageList, appendMessage, appendDelta, type MessageEntry } from '@tui/components/message-list';
import { createSidebar, updateSidebarItems } from '@tui/components/sidebar';
import { tags } from '@tui/theme';

export class ChatScreen {
  private messageList: blessed.Widgets.BoxElement;
  private input: blessed.Widgets.TextareaElement;
  private conversationSidebar: blessed.Widgets.ListElement;
  private currentConversationId: string | null = null;
  private currentWorkspaceId: string | null = null;
  private currentModel = '';
  private streamingContent = '';

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: DesktopAppContext
  ) {
    this.conversationSidebar = createSidebar(screen, {
      label: 'Conversations',
      items: [],
      selectedIndex: 0,
      width: 24
    });

    this.messageList = createMessageList(screen, 24);

    this.input = createChatInput(screen, {
      onSubmit: (text) => this.handleSubmit(text),
      onCancel: () => this.handleCancel()
    });

    this.conversationSidebar.on('select', (_item: unknown, index: number) => {
      this.selectConversation(index);
    });
  }

  async init(): Promise<void> {
    this.loadConversations();
    this.loadSettings();
    this.input.focus();
    this.screen.render();
  }

  private loadSettings(): void {
    const settings = this.ctx.settingsService.get();
    this.currentModel = settings.textModel;
  }

  private loadConversations(): void {
    const conversations = this.ctx.repository.listConversations(this.currentWorkspaceId);
    const items = conversations.map(c => c.title ?? 'Untitled');
    updateSidebarItems(this.conversationSidebar, items, 0);
  }

  private selectConversation(index: number): void {
    const conversations = this.ctx.repository.listConversations(this.currentWorkspaceId);
    const conv = conversations[index];
    if (!conv) return;

    this.currentConversationId = conv.id;

    const messages = this.ctx.repository.getMessages(conv.id);
    this.messageList.setContent('');
    for (const msg of messages) {
      appendMessage(this.messageList, {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content
      });
    }
    this.screen.render();
  }

  private handleSubmit(text: string): void {
    appendMessage(this.messageList, { role: 'user', content: text });
    this.streamingContent = '';

    void this.ctx.chatService.submitPrompt(
      {
        prompt: text,
        conversationId: this.currentConversationId ?? undefined,
        workspaceId: this.currentWorkspaceId ?? undefined,
        model: this.currentModel || undefined
      },
      (event: ChatStreamEvent) => this.handleStreamEvent(event)
    ).then((result) => {
      this.currentConversationId = result.conversationId;
      this.loadConversations();
    }).catch((err: unknown) => {
      appendMessage(this.messageList, {
        role: 'system',
        content: `Error: ${(err as Error).message}`
      });
    });
  }

  private handleStreamEvent(event: ChatStreamEvent): void {
    switch (event.type) {
      case 'delta': {
        if (this.streamingContent.length === 0) {
          // First delta of a new assistant turn
          appendMessage(this.messageList, { role: 'assistant', content: '' });
        }
        this.streamingContent += event.delta;
        appendDelta(this.messageList, event.delta);
        break;
      }
      case 'complete':
        this.streamingContent = '';
        this.screen.render();
        break;
      case 'error':
        appendMessage(this.messageList, {
          role: 'system',
          content: `Stream error: ${event.message}`
        });
        this.screen.render();
        break;
    }
  }

  private handleCancel(): void {
    // Cancel handled at app level
  }

  focus(): void {
    this.input.focus();
    this.screen.render();
  }

  setWorkspace(workspaceId: string | null): void {
    this.currentWorkspaceId = workspaceId;
    this.currentConversationId = null;
    this.loadConversations();
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getModel(): string {
    return this.currentModel;
  }

  getWorkspaceId(): string | null {
    return this.currentWorkspaceId;
  }

  getInput(): blessed.Widgets.TextareaElement {
    return this.input;
  }
}