function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function extractJsonCandidate(value: string): string | null {
  const trimmed = value.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fencedMatch?.[1] ?? trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null;
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}

function tryParseRecord(candidate: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function repairJsonStringLiterals(candidate: string): string {
  let repaired = '';
  let inString = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index] ?? '';

    if (!inString) {
      repaired += character;

      if (character === '"') {
        inString = true;
      }

      continue;
    }

    if (character === '\\') {
      const next = candidate[index + 1];

      if (!next) {
        repaired += '\\\\';
        continue;
      }

      if (/["\\/bfnrt]/.test(next)) {
        repaired += `\\${next}`;
        index += 1;
        continue;
      }

      if (next === 'u' && /^[\da-fA-F]{4}$/.test(candidate.slice(index + 2, index + 6))) {
        repaired += `\\u${candidate.slice(index + 2, index + 6)}`;
        index += 5;
        continue;
      }

      repaired += '\\\\';
      continue;
    }

    if (character === '"') {
      const nextToken = candidate.slice(index + 1).match(/^\s*([,:}\]])/)?.[1] ?? null;

      if (nextToken) {
        repaired += character;
        inString = false;
        continue;
      }

      repaired += '\\"';
      continue;
    }

    if (character === '\r') {
      repaired += '\\r';
      continue;
    }

    if (character === '\n') {
      repaired += '\\n';
      continue;
    }

    if (character === '\t') {
      repaired += '\\t';
      continue;
    }

    if (character < ' ') {
      repaired += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }

    repaired += character;
  }

  return repaired;
}

export function parseJsonishRecord(value: string): Record<string, unknown> | null {
  const candidate = extractJsonCandidate(value);

  if (!candidate) {
    return null;
  }

  const parsed = tryParseRecord(candidate);

  if (parsed) {
    return parsed;
  }

  return tryParseRecord(repairJsonStringLiterals(candidate));
}
