import type blessed from 'blessed';
import type { DesktopAppContext } from '@bridge/app-context';
import { tags, boxStyle } from '@tui/theme';

export class CapabilitiesScreen {
  private panel: blessed.Widgets.BoxElement;

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: DesktopAppContext
  ) {
    this.panel = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      right: 0,
      bottom: 1,
      style: boxStyle,
      border: { type: 'line' },
      label: ' Capabilities ',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      tags: true
    });
  }

  init(): void {
    this.renderAll();
    this.screen.render();
  }

  private renderAll(): void {
    const sections: string[] = [];

    const permissions = this.ctx.capabilityService.listPermissions();
    sections.push(tags.bold('=== Permissions ==='));
    if (permissions.length === 0) {
      sections.push(tags.muted('  (none)'));
    }
    for (const p of permissions) {
      sections.push(`  ${tags.accent(p.capabilityId)} ${p.scopeKind} ${tags.success('granted')}`);
    }
    sections.push('');

    const tasks = this.ctx.capabilityService.listTasks(null);
    sections.push(tags.bold('=== Tasks ==='));
    if (tasks.length === 0) {
      sections.push(tags.muted('  (none)'));
    }
    for (const t of tasks) {
      const status = t.status === 'completed'
        ? tags.success(t.status)
        : t.status === 'failed'
          ? tags.error(t.status)
          : tags.warning(t.status);
      sections.push(`  ${tags.accent(t.id.substring(0, 8))} ${status}`);
    }
    sections.push('');

    const agents = this.ctx.capabilityService.listAgents();
    sections.push(tags.bold('=== Agents ==='));
    if (agents.length === 0) {
      sections.push(tags.muted('  (none)'));
    }
    for (const a of agents) {
      sections.push(`  ${tags.accent(a.id.substring(0, 8))} ${a.status}`);
    }
    sections.push('');

    const schedules = this.ctx.capabilityService.listSchedules();
    sections.push(tags.bold('=== Schedules ==='));
    if (schedules.length === 0) {
      sections.push(tags.muted('  (none)'));
    }
    for (const s of schedules) {
      sections.push(`  ${tags.accent(s.id.substring(0, 8))} ${s.kind}`);
    }
    sections.push('');

    const tools = this.ctx.chatService.listTools();
    sections.push(tags.bold('=== Available Tools ==='));
    for (const t of tools) {
      sections.push(`  ${tags.accent(t.name)} - ${tags.muted((t.description ?? '').substring(0, 60))}`);
    }

    this.panel.setContent(sections.join('\n'));
  }

  focus(): void {
    this.panel.focus();
    this.screen.render();
  }
}