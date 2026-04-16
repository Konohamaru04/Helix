import { describe, it, expect } from 'vitest';
import { formatStatusBar } from '../../../../tui/components/status-bar';

describe('formatStatusBar', () => {
  it('formats status bar with all fields', () => {
    const result = formatStatusBar({
      model: 'llama3.1',
      workspace: 'default',
      ollamaStatus: 'connected',
      screen: 'chat'
    });
    expect(result).toContain('llama3.1');
    expect(result).toContain('default');
    expect(result).toContain('connected');
  });

  it('handles disconnected ollama', () => {
    const result = formatStatusBar({
      model: 'none',
      workspace: 'default',
      ollamaStatus: 'disconnected',
      screen: 'chat'
    });
    expect(result).toContain('disconnected');
  });
});