const PATH_TOKEN_SOURCE =
  "[A-Za-z]:\\\\[^\\s\"`]+|\\.{1,2}(?:[\\\\/][^\\s\"`]+)+|~?(?:[\\\\/][^\\s\"`]+)+|[A-Za-z0-9_'.-]+(?:[\\\\/][A-Za-z0-9_'. -]+)+|\\.?[A-Za-z0-9_'-]+(?:\\.[A-Za-z0-9_'-]+)+";
const LOOSE_FILENAME_SOURCE =
  "\\.?[A-Za-z0-9_'-]+(?:[ .-][A-Za-z0-9_'-]+)*\\.[A-Za-z0-9_'-]+(?:\\.[A-Za-z0-9_'-]+)*";

const PATH_TOKEN_PATTERN = new RegExp(PATH_TOKEN_SOURCE, 'gi');
const KEYED_PATH_PATTERN = new RegExp(
  `(?:\\b(?:file\\s*name|filename|file|path|target|document)\\b\\s*(?:is|=|:)?\\s*|\\b(?:in|inside|under|from|at|read|open)\\b\\s+)(?:"([^"]+)"|'([^']+)'|(${PATH_TOKEN_SOURCE})|(${LOOSE_FILENAME_SOURCE}))`,
  'gi'
);
const INLINE_QUOTED_PATTERN = /["']([^"']+)["']/g;
const LOOSE_FILENAME_PATTERN = new RegExp(`^${LOOSE_FILENAME_SOURCE}$`, 'i');

function normalizePathCandidate(value: string): string {
  return value.trim().replace(/^[("'`]+|[)"'`]+$/g, '').replace(/[),;:!?]+$/g, '').trim();
}

export function looksLikeStructuredPath(value: string): boolean {
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
    /^[A-Za-z0-9_'-]+(?:\.[A-Za-z0-9_'-]+)+$/.test(candidate)
  );
}

function looksLikeLooseFilename(value: string): boolean {
  const candidate = normalizePathCandidate(value);
  return Boolean(candidate) && LOOSE_FILENAME_PATTERN.test(candidate);
}

function looksLikePathInstruction(value: string): boolean {
  return /\b(?:file\s*name|filename|file|path|target|document|read|open|show|inspect|summari[sz]e|try|again|please|is|the|this|that)\b/i.test(
    value
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

  if (
    looksLikeStructuredPath(standaloneCandidate) ||
    (looksLikeLooseFilename(standaloneCandidate) && !looksLikePathInstruction(standaloneCandidate))
  ) {
    return standaloneCandidate || null;
  }

  const directVerbMatch = trimmedPrompt.match(
    /^(?:read|open|show|inspect|summari[sz]e)\s+(.+)$/i
  );
  const directVerbCandidate = normalizePathCandidate(directVerbMatch?.[1] ?? '');

  if (looksLikeStructuredPath(directVerbCandidate) || looksLikeLooseFilename(directVerbCandidate)) {
    return directVerbCandidate || null;
  }

  const keyedRemainderMatch = trimmedPrompt.match(
    /^(?:file\s*name|filename|file|path|target|document)\s*(?:is|=|:)?\s+(.+)$/i
  );
  const keyedRemainderCandidate = normalizePathCandidate(keyedRemainderMatch?.[1] ?? '');

  if (
    looksLikeStructuredPath(keyedRemainderCandidate) ||
    looksLikeLooseFilename(keyedRemainderCandidate)
  ) {
    return keyedRemainderCandidate || null;
  }

  for (const match of trimmedPrompt.matchAll(KEYED_PATH_PATTERN)) {
    const candidate = normalizePathCandidate(
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    );

    if (looksLikeStructuredPath(candidate) || looksLikeLooseFilename(candidate)) {
      return candidate;
    }
  }

  for (const match of trimmedPrompt.matchAll(INLINE_QUOTED_PATTERN)) {
    const candidate = normalizePathCandidate(match[1] ?? '');

    if (looksLikeStructuredPath(candidate) || looksLikeLooseFilename(candidate)) {
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
