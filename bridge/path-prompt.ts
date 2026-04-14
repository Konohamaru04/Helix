const PATH_TOKEN_SOURCE =
  '[A-Za-z]:\\\\[^\\s"\'`]+|\\.{1,2}(?:[\\\\/][^\\s"\'`]+)+|~?(?:[\\\\/][^\\s"\'`]+)+|[A-Za-z0-9_.-]+(?:[\\\\/][A-Za-z0-9_.-]+)+|\\.?[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+';

const PATH_TOKEN_PATTERN = new RegExp(PATH_TOKEN_SOURCE, 'gi');
const KEYED_PATH_PATTERN = new RegExp(
  `(?:\\b(?:file\\s*name|filename|file|path|target|document)\\b\\s*(?:is|=|:)?\\s*|\\b(?:in|inside|under|from|at|read|open)\\b\\s+)(?:"([^"]+)"|'([^']+)'|(${PATH_TOKEN_SOURCE}))`,
  'gi'
);
const INLINE_QUOTED_PATTERN = /["']([^"']+)["']/g;

function normalizePathCandidate(value: string): string {
  return value.trim().replace(/^[("'`]+|[)"'`]+$/g, '').replace(/[),.;:!?]+$/g, '').trim();
}

function looksLikeStructuredPath(value: string): boolean {
  const candidate = normalizePathCandidate(value);

  if (!candidate) {
    return false;
  }

  return (
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    /^\.{1,2}(?:[\\/]|$)/.test(candidate) ||
    /^[\\/]/.test(candidate) ||
    /^~[\\/]/.test(candidate) ||
    /[\\/]/.test(candidate) ||
    /^\.[A-Za-z0-9_.-]+$/.test(candidate) ||
    /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(candidate)
  );
}

export function extractPromptPathCandidate(prompt: string): string | null {
  const trimmedPrompt = prompt.trim();

  if (!trimmedPrompt) {
    return null;
  }

  const fullyQuotedMatch =
    trimmedPrompt.match(/^"(.*)"$/s) ?? trimmedPrompt.match(/^'(.*)'$/s);

  if (fullyQuotedMatch?.[1] !== undefined) {
    const candidate = normalizePathCandidate(fullyQuotedMatch[1]);
    return candidate || null;
  }

  const standaloneCandidate = normalizePathCandidate(trimmedPrompt);

  if (!/\s/.test(trimmedPrompt) || looksLikeStructuredPath(standaloneCandidate)) {
    return standaloneCandidate || null;
  }

  for (const match of trimmedPrompt.matchAll(KEYED_PATH_PATTERN)) {
    const candidate = normalizePathCandidate(
      match[1] ?? match[2] ?? match[3] ?? ''
    );

    if (looksLikeStructuredPath(candidate)) {
      return candidate;
    }
  }

  for (const match of trimmedPrompt.matchAll(INLINE_QUOTED_PATTERN)) {
    const candidate = normalizePathCandidate(match[1] ?? '');

    if (looksLikeStructuredPath(candidate)) {
      return candidate;
    }
  }

  for (const match of trimmedPrompt.matchAll(PATH_TOKEN_PATTERN)) {
    const candidate = normalizePathCandidate(match[0] ?? '');

    if (looksLikeStructuredPath(candidate)) {
      return candidate;
    }
  }

  return null;
}
