import blessed from 'blessed';
import { colors, inputStyle, tags } from '@tui/theme';

export function splitPromptFromInput(value: string): string {
  return value.trim();
}

export interface ChatInputOptions {
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

export function createChatInput(
  parent: blessed.Widgets.Screen,
  options: ChatInputOptions
): blessed.Widgets.TextareaElement {
  const input = blessed.textarea({
    parent,
    bottom: 1,
    left: 24,
    right: 0,
    height: 5,
    style: {
      ...inputStyle,
      focus: { ...inputStyle.focus, fg: colors.fg }
    },
    border: { type: 'line' },
    label: ' Input ',
    tags: true,
    inputOnFocus: true
  });

  input.key('enter', () => {
    const text = splitPromptFromInput(input.getValue());
    if (text) {
      options.onSubmit(text);
      input.clearValue();
      input.screen.render();
    }
  });

  input.key('C-enter', () => {
    input.insertLine();
  });

  input.key('escape', () => {
    options.onCancel();
  });

  return input;
}

export function focusInput(input: blessed.Widgets.TextareaElement): void {
  input.focus();
  input.screen.render();
}