import { APP_USER_AGENT } from '@bridge/branding';

const DEFAULT_WEB_SEARCH_LIMIT = 5;
const WEB_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDuckDuckGoRedirectUrl(rawUrl: string): string {
  const decodedUrl = decodeHtmlEntities(rawUrl);
  const normalizedUrl = decodedUrl.startsWith('//')
    ? `https:${decodedUrl}`
    : decodedUrl;

  try {
    const parsed = new URL(normalizedUrl);
    const redirectedUrl = parsed.searchParams.get('uddg');

    return redirectedUrl ? decodeURIComponent(redirectedUrl) : normalizedUrl;
  } catch {
    return normalizedUrl;
  }
}

function parseSearchResults(html: string, limit: number): WebSearchResult[] {
  const titlePattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const titleMatches = [...html.matchAll(titlePattern)];
  const snippetMatches = [...html.matchAll(snippetPattern)];
  const matches: WebSearchResult[] = [];

  for (let index = 0; index < titleMatches.length && matches.length < limit; index += 1) {
    const titleMatch = titleMatches[index];
    const snippetMatch = snippetMatches[index];
    const url = extractDuckDuckGoRedirectUrl(titleMatch?.[1] ?? '');
    const title = decodeHtmlEntities(titleMatch?.[2] ?? '');
    const snippet = decodeHtmlEntities(snippetMatch?.[1] ?? '');

    if (title && url && snippet) {
      matches.push({
        title,
        url,
        snippet
      });
    }
  }

  return matches;
}

export async function searchWeb(
  query: string,
  limit = DEFAULT_WEB_SEARCH_LIMIT
): Promise<WebSearchResult[]> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return [];
  }

  const url = new URL(WEB_SEARCH_ENDPOINT);
  url.searchParams.set('q', trimmedQuery);

  const response = await fetch(url, {
    headers: {
      'user-agent': APP_USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Web search request failed with status ${response.status}.`);
  }

  const html = await response.text();
  const results = parseSearchResults(html, Math.max(1, limit));

  if (results.length === 0) {
    throw new Error('No web search results were returned for that query.');
  }

  return results;
}
