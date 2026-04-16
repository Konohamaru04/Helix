import blessed from 'blessed';
import MarkdownIt from 'markdown-it';
import { colors, tags, boxStyle } from '@tui/theme';

const md = new MarkdownIt();

export function markdownToBlessed(text: string): string {
  const tokens = md.parse(text, {});

  let output = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph_open':
        break;
      case 'paragraph_close':
        output += '\n';
        break;
      case 'inline':
        for (const child of token.children ?? []) {
          switch (child.type) {
            case 'strong_open':
              output += '{bold}';
              break;
            case 'strong_close':
              output += '{/bold}';
              break;
            case 'em_open':
              output += '{underline}';
              break;
            case 'em_close':
              output += '{/underline}';
              break;
            case 'code_inline':
              output += `{${colors.accent}-fg}${child.content}{/${colors.accent}-fg}`;
              break;
            default:
              output += child.content;
          }
        }
        break;
      case 'fence':
      case 'code_block':
        output += `{${colors.dim}-fg}---${token.info ? ' ' + token.info : ''}{/${colors.dim}-fg}\n`;
        for (const line of token.content.split('\n')) {
          output += `{${colors.muted}-fg}${line}{/${colors.muted}-fg}\n`;
        }
        output += `{${colors.dim}-fg}---{/${colors.dim}-fg}\n`;
        break;
      case 'heading_open':
        output += '{bold}';
        break;
      case 'heading_close':
        output += '{/bold}\n';
        break;
      case 'text':
        output += token.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        output += '\n';
        break;
      case 'bullet_list_open':
      case 'ordered_list_open':
        break;
      case 'list_item_open':
        output += '  * ';
        break;
      case 'list_item_close':
        output += '\n';
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        break;
      default:
        if (token.content) output += token.content;
    }
  }

  return output.trimEnd();
}

export interface MessageEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function formatMessage(msg: MessageEntry): string {
  const roleTag = msg.role === 'user'
    ? tags.accent('You:')
    : msg.role === 'assistant'
      ? tags.success('Assistant:')
      : tags.muted('System:');
  const rendered = markdownToBlessed(msg.content);
  return `${roleTag}\n${rendered}\n`;
}

export function createMessageList(
  parent: blessed.Widgets.Screen,
  left: number
): blessed.Widgets.BoxElement {
  const list = blessed.box({
    parent,
    top: 0,
    left,
    right: 0,
    bottom: 6,
    style: boxStyle,
    border: { type: 'line' },
    label: ' Messages ',
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    tags: true,
    scrollbar: {
      ch: '|',
      style: { fg: colors.accent }
    }
  });

  return list;
}

export function appendMessage(
  list: blessed.Widgets.BoxElement,
  msg: MessageEntry
): void {
  const current = list.getContent() as string;
  const formatted = formatMessage(msg);
  list.setContent(current + (current ? '\n' : '') + formatted);
  list.setScrollPerc(100);
  list.screen.render();
}

export function appendDelta(
  list: blessed.Widgets.BoxElement,
  delta: string
): void {
  const current = list.getContent() as string;
  list.setContent(current + delta);
  list.setScrollPerc(100);
  list.screen.render();
}