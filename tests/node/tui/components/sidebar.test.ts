import { describe, it, expect } from 'vitest';
import { formatSidebarItem } from '../../../../tui/components/sidebar';

describe('formatSidebarItem', () => {
  it('formats selected item with accent', () => {
    const result = formatSidebarItem('My Chat', true, 0);
    expect(result).toContain('My Chat');
  });

  it('formats unselected item as muted', () => {
    const result = formatSidebarItem('Other Chat', false, 1);
    expect(result).toContain('Other Chat');
  });
});