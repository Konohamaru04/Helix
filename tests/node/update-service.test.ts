import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareSemver, fetchUpdateStatus } from '@bridge/update/service';

describe('compareSemver', () => {
  it('orders versions ignoring leading v and treats pre-release suffixes lexicographically', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('v1.0.1', '1.0.0')).toBe(1);
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1);
    // Pre-release suffixes parse to extra zero-or-numeric parts, so any suffix
    // makes the version sort *after* the bare equivalent. This is intentional
    // for now — Helix releases are tagged without -beta suffixes.
    expect(compareSemver('2.0.0-beta.1', '2.0.0')).toBe(1);
  });
});

describe('fetchUpdateStatus', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports an update when the remote tag is newer', async () => {
    const release = {
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/owner/repo/releases/tag/v1.2.0',
      published_at: '2026-04-20T00:00:00Z',
      body: 'New things'
    };
    const commits = [
      {
        sha: 'abcdef1234567890',
        html_url: 'https://github.com/owner/repo/commit/abcdef1234567890',
        commit: {
          message: 'feat: shiny\n\nbody',
          author: { date: '2026-04-21T00:00:00Z' }
        }
      }
    ];

    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(JSON.stringify(release), { status: 200 });
        }
        if (url.includes('/commits')) {
          return new Response(JSON.stringify(commits), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }
    );

    const result = await fetchUpdateStatus({
      currentVersion: '1.1.0',
      repo: 'owner/repo'
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe('v1.2.0');
    expect(result.releaseNotes).toBe('New things');
    expect(result.latestCommit?.sha).toBe('abcdef1');
    expect(result.latestCommit?.message).toBe('feat: shiny');
    expect(result.error).toBeNull();
  });

  it('returns hasUpdate=false and propagates errors when both calls fail', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Server Error' })
    );

    const result = await fetchUpdateStatus({
      currentVersion: '1.0.0',
      repo: 'owner/repo'
    });

    expect(result.hasUpdate).toBe(false);
    expect(result.latestVersion).toBeNull();
    expect(result.error).toContain('GitHub 500');
  });
});
