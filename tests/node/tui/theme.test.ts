import { describe, it, expect } from 'vitest';
import { colors, tags } from '../../../tui/theme';

describe('TUI theme', () => {
  it('exports color constants matching Helix dark theme', () => {
    expect(colors.bg).toBe('#020617');
    expect(colors.fg).toBe('#e2e8f0');
    expect(colors.accent).toBe('#6366f1');
    expect(colors.muted).toBe('#64748b');
    expect(colors.error).toBe('#ef4444');
    expect(colors.success).toBe('#22c55e');
  });

  it('exports blessed tag templates', () => {
    expect(tags.bold('hello')).toBe('{bold}hello{/bold}');
    expect(tags.accent('test')).toBe('{#6366f1-fg}test{/#6366f1-fg}');
    expect(tags.error('fail')).toBe('{#ef4444-fg}fail{/#ef4444-fg}');
  });
});