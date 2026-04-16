import blessed from 'blessed';
import { colors, tags, boxStyle } from '@tui/theme';

export function parseModelList(output: string): string[] {
  const lines = output.split('\n').slice(1); // skip header
  return lines
    .map(line => line.split('\t')[0]?.trim())
    .filter((name): name is string => !!name);
}

export function createModelSelect(
  parent: blessed.Widgets.Screen,
  onSelect: (model: string) => void
): blessed.Widgets.ListElement {
  const list = blessed.list({
    parent,
    top: 'center',
    left: 'center',
    width: 40,
    height: 12,
    style: {
      ...boxStyle,
      selected: { fg: colors.accent, bg: colors.bg }
    },
    border: { type: 'line' },
    label: ' Select Model ',
    keys: true,
    mouse: true,
    tags: true,
    hidden: true
  });

  list.key(['enter'], () => {
    const selected = list.items[list.selected]?.content.replace(/\{[^}]+\}/g, '').trim();
    if (selected) {
      onSelect(selected);
      list.hide();
      list.screen.render();
    }
  });

  list.key(['escape'], () => {
    list.hide();
    list.screen.render();
  });

  return list;
}

export function showModelSelect(
  list: blessed.Widgets.ListElement,
  models: string[],
  currentModel: string
): void {
  list.setItems(models.map(m =>
    m === currentModel ? tags.accent(`* ${m}`) : `  ${m}`
  ));
  const idx = models.indexOf(currentModel);
  if (idx >= 0) list.select(idx);
  list.show();
  list.focus();
  list.screen.render();
}