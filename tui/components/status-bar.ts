import blessed from 'blessed';
import { colors, tags } from '@tui/theme';

export interface StatusBarState {
  model: string;
  workspace: string;
  ollamaStatus: 'connected' | 'disconnected';
  screen: string;
}

export function formatStatusBar(state: StatusBarState): string {
  const statusIcon = state.ollamaStatus === 'connected'
    ? tags.success('*')
    : tags.error('x');
  const parts = [
    `workspace: ${state.workspace}`,
    `model: ${state.model}`,
    `ollama: ${statusIcon} ${state.ollamaStatus}`,
    `screen: ${state.screen}`
  ];
  return parts.join('  ');
}

export function createStatusBar(parent: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
  const bar = blessed.box({
    parent,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    style: {
      bg: colors.sidebar,
      fg: colors.muted
    },
    tags: true
  });

  return bar;
}

export function updateStatusBar(bar: blessed.Widgets.BoxElement, state: StatusBarState): void {
  bar.setContent(formatStatusBar(state));
  bar.screen.render();
}