import { describe, it, expect } from 'vitest';
import { splitPromptFromInput } from '../../../../tui/components/chat-input';

describe('splitPromptFromInput', () => {
  it('splits single-line input', () => {
    expect(splitPromptFromInput('hello')).toBe('hello');
  });

  it('preserves newlines in multi-line input', () => {
    expect(splitPromptFromInput('line1\nline2')).toBe('line1\nline2');
  });

  it('trims whitespace', () => {
    expect(splitPromptFromInput('  hello  ')).toBe('hello');
  });

  it('returns empty for whitespace-only input', () => {
    expect(splitPromptFromInput('   ')).toBe('');
  });
});