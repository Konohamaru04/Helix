import { describe, it, expect } from 'vitest';
import { markdownToBlessed } from '../../../../tui/components/message-list';

describe('markdownToBlessed', () => {
  it('converts bold markdown to blessed tags', () => {
    const result = markdownToBlessed('hello **world**');
    expect(result).toContain('{bold}world{/bold}');
  });

  it('converts inline code to colored text', () => {
    const result = markdownToBlessed('use `foo()` to call');
    expect(result).toContain('foo()');
  });

  it('passes through plain text unchanged', () => {
    expect(markdownToBlessed('plain text')).toBe('plain text');
  });

  it('converts code blocks', () => {
    const result = markdownToBlessed('```js\nconst x = 1;\n```');
    expect(result).toContain('const x = 1;');
  });
});