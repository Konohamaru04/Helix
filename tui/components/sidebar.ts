import blessed from 'blessed';
import { colors, tags } from '@tui/theme';

export function formatSidebarItem(label: string, selected: boolean, _index: number): string {
  const prefix = selected ? tags.accent(' >') : '  ';
  const text = selected ? tags.bold(label) : tags.muted(label);
  return `${prefix} ${text}`;
}

export interface SidebarOptions {
  label: string;
  items: string[];
  selectedIndex: number;
  width?: number;
}

export function createSidebar(
  parent: blessed.Widgets.Screen,
  options: SidebarOptions
): blessed.Widgets.ListElement {
  const list = blessed.list({
    parent,
    top: 0,
    left: 0,
    width: options.width ?? 24,
    bottom: 1,
    label: ` ${options.label} `,
    style: {
      bg: colors.sidebar,
      fg: colors.fg,
      border: { fg: colors.border },
      selected: { fg: colors.accent, bg: colors.sidebar },
      item: { fg: colors.muted },
      label: { fg: colors.accent }
    },
    border: { type: 'line' },
    mouse: true,
    keys: true,
    vi: true,
    tags: true,
    items: options.items.map((item, i) =>
      formatSidebarItem(item, i === options.selectedIndex, i)
    )
  });

  list.select(options.selectedIndex);

  return list;
}

export function updateSidebarItems(
  list: blessed.Widgets.ListElement,
  items: string[],
  selectedIndex: number
): void {
  list.setItems(items.map((item, i) =>
    formatSidebarItem(item, i === selectedIndex, i)
  ));
  list.select(selectedIndex);
  list.screen.render();
}