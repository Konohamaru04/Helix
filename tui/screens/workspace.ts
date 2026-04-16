import type blessed from 'blessed';
import type { DesktopAppContext } from '@bridge/app-context';
import { createSidebar, updateSidebarItems } from '@tui/components/sidebar';
import { tags, boxStyle } from '@tui/theme';

export class WorkspaceScreen {
  private list: blessed.Widgets.ListElement;
  private detail: blessed.Widgets.BoxElement;
  private selectedIndex = 0;

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: DesktopAppContext,
    private onWorkspaceSwitch: (workspaceId: string | null) => void
  ) {
    this.list = createSidebar(screen, {
      label: 'Workspaces',
      items: [],
      selectedIndex: 0,
      width: 30
    });

    this.detail = blessed.box({
      parent: screen,
      top: 0,
      left: 30,
      right: 0,
      bottom: 1,
      style: boxStyle,
      border: { type: 'line' },
      label: ' Workspace Details ',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      tags: true
    });

    this.list.on('select', (_item: unknown, index: number) => {
      this.selectedIndex = index;
      this.showDetail();
    });
  }

  init(): void {
    this.refreshList();
    this.screen.render();
  }

  refreshList(): void {
    const workspaces = this.ctx.chatService.listWorkspaces();
    const items = workspaces.map(w => w.name);
    updateSidebarItems(this.list, items, this.selectedIndex);
  }

  private showDetail(): void {
    const workspaces = this.ctx.chatService.listWorkspaces();
    const ws = workspaces[this.selectedIndex];
    if (!ws) {
      this.detail.setContent(tags.muted('No workspace selected'));
      this.screen.render();
      return;
    }

    const convCount = this.ctx.repository.listConversations(ws.id).length;
    const content = [
      `${tags.bold('Name:')} ${ws.name}`,
      `${tags.bold('ID:')} ${ws.id}`,
      `${tags.bold('Root:')} ${ws.rootPath ?? tags.dim('(none)')}`,
      `${tags.bold('Conversations:')} ${convCount}`,
      '',
      tags.muted('Press Ctrl+W to switch to this workspace')
    ].join('\n');

    this.detail.setContent(content);
    this.screen.render();
  }

  getSelectedWorkspaceId(): string | null {
    const workspaces = this.ctx.chatService.listWorkspaces();
    return workspaces[this.selectedIndex]?.id ?? null;
  }

  focus(): void {
    this.list.focus();
    this.screen.render();
  }
}