const DEFAULT_EMBEDDING_DIMENSIONS = 96;
const LOCAL_EMBEDDING_MODEL = 'local-hash-96-v1';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashFeature(value: string, seed: number): number {
  let hash = seed >>> 0;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number) {
  const primaryHash = hashFeature(feature, 2166136261);
  const secondaryHash = hashFeature(feature, 0x9e3779b9);
  const index = primaryHash % vector.length;
  const signedWeight = (secondaryHash & 1) === 0 ? weight : -weight;
  vector[index] = (vector[index] ?? 0) + signedWeight;
}

function tokenizeWords(value: string): string[] {
  return normalizeText(value).match(/[a-z0-9_]{2,}/g) ?? [];
}

function tokenizeTrigrams(value: string): string[] {
  const normalized = normalizeText(value).replace(/[^a-z0-9_]+/g, ' ');
  const compact = normalized.replace(/\s+/g, ' ').trim();

  if (compact.length < 3) {
    return compact ? [compact] : [];
  }

  const tokens: string[] = [];

  for (let index = 0; index <= compact.length - 3; index += 1) {
    const trigram = compact.slice(index, index + 3);

    if (!/\s/.test(trigram)) {
      tokens.push(trigram);
    }
  }

  return tokens;
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((total, value) => total + value * value, 0)
  );

  if (magnitude === 0) {
    return vector.map(() => 0);
  }

  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

export function buildLocalEmbedding(
  value: string,
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const words = tokenizeWords(value);
  const trigrams = tokenizeTrigrams(value);

  for (const word of words) {
    addFeature(vector, `word:${word}`, 2);
  }

  for (const trigram of trigrams) {
    addFeature(vector, `tri:${trigram}`, 1);
  }

  return l2Normalize(vector);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return 0;
  }

  let dotProduct = 0;

  for (let index = 0; index < left.length; index += 1) {
    dotProduct += (left[index] ?? 0) * (right[index] ?? 0);
  }

  return Number(dotProduct.toFixed(8));
}

export function serializeEmbedding(vector: number[]): string {
  return JSON.stringify(vector);
}

export function parseEmbedding(value: string): number[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Stored embedding was not an array.');
  }

  return parsed.map((item) => Number(item));
}

export {
  DEFAULT_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL
};
