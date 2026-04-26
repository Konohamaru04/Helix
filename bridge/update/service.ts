export interface UpdateCheckCommit {
  sha: string;
  message: string;
  date: string;
  url: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  latestCommit: UpdateCheckCommit | null;
  checkedAt: string;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 6_000;

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const li = left[i] ?? 0;
    const ri = right[i] ?? 0;
    if (li !== ri) return li < ri ? -1 : 1;
  }
  return 0;
}

async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchUpdateStatusOptions {
  currentVersion: string;
  repo: string;
  timeoutMs?: number;
}

export async function fetchUpdateStatus(
  options: FetchUpdateStatusOptions
): Promise<UpdateCheckResult> {
  const { currentVersion, repo } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Helix/${currentVersion}`
  };
  const checkedAt = new Date().toISOString();

  try {
    const [releasePayload, commitsPayload] = await Promise.allSettled([
      fetchJsonWithTimeout(
        `https://api.github.com/repos/${repo}/releases/latest`,
        headers,
        timeoutMs
      ),
      fetchJsonWithTimeout(
        `https://api.github.com/repos/${repo}/commits?per_page=1`,
        headers,
        timeoutMs
      )
    ]);

    let latestVersion: string | null = null;
    let releaseUrl: string | null = null;
    let publishedAt: string | null = null;
    let releaseNotes: string | null = null;
    if (releasePayload.status === 'fulfilled') {
      const release = releasePayload.value as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
        body?: string;
      };
      latestVersion = release.tag_name ?? null;
      releaseUrl = release.html_url ?? null;
      publishedAt = release.published_at ?? null;
      releaseNotes = release.body ? release.body.slice(0, 4_000) : null;
    }

    let latestCommit: UpdateCheckCommit | null = null;
    if (commitsPayload.status === 'fulfilled' && Array.isArray(commitsPayload.value)) {
      const first = (commitsPayload.value as Array<{
        sha: string;
        html_url?: string;
        commit: { message: string; author: { date: string } };
      }>)[0];
      if (first) {
        latestCommit = {
          sha: first.sha.slice(0, 7),
          message: ((first.commit.message ?? '').split('\n')[0] ?? '').slice(0, 140),
          date: first.commit.author.date,
          url: first.html_url ?? `https://github.com/${repo}/commit/${first.sha}`
        };
      }
    }

    const hasUpdate =
      latestVersion !== null && compareSemver(currentVersion, latestVersion) < 0;
    const error =
      releasePayload.status === 'rejected' && commitsPayload.status === 'rejected'
        ? releasePayload.reason instanceof Error
          ? releasePayload.reason.message
          : String(releasePayload.reason)
        : null;

    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      publishedAt,
      releaseNotes,
      latestCommit,
      checkedAt,
      error
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: null,
      publishedAt: null,
      releaseNotes: null,
      latestCommit: null,
      checkedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
