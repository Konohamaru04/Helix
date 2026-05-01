import type { Logger } from 'pino';
import { OllamaClient } from './client';

const VISION_MODEL_REGEX = /(vl|vision|llava)/i;

export class VisionCapabilityCache {
  private readonly cache = new Map<string, boolean>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly ollamaClient: OllamaClient,
    private readonly logger: Logger
  ) {}

  /** Synchronous check — returns cached /api/show result or regex fallback. */
  isVisionCapable(model: string): boolean {
    if (this.cache.has(model)) {
      return this.cache.get(model)!;
    }

    return VISION_MODEL_REGEX.test(model);
  }

  /** Async check — queries Ollama /api/show, caches result, falls back to regex on error. */
  async resolveVisionCapability(baseUrl: string, model: string): Promise<boolean> {
    if (this.cache.has(model)) {
      return this.cache.get(model)!;
    }

    if (this.pending.has(model)) {
      return this.pending.get(model)!;
    }

    const promise = (async () => {
      try {
        const show = await this.ollamaClient.showModel(baseUrl, model);
        const families = show.details?.families ?? [];
        const hasClip = families.includes('clip');
        this.logger.debug(
          { model, families, hasClip },
          'Resolved vision capability from /api/show'
        );
        this.cache.set(model, hasClip);
        return hasClip;
      } catch (error) {
        const fallback = VISION_MODEL_REGEX.test(model);
        this.logger.warn(
          { model, error: error instanceof Error ? error.message : String(error), fallback },
          'Failed to resolve vision capability, using regex fallback'
        );
        this.cache.set(model, fallback);
        return fallback;
      } finally {
        this.pending.delete(model);
      }
    })();

    this.pending.set(model, promise);
    return promise;
  }

  /** Pre-warm the cache for a set of models. */
  async preWarm(baseUrl: string, models: string[]): Promise<void> {
    await Promise.allSettled(
      models.map((model) => this.resolveVisionCapability(baseUrl, model))
    );
  }

  /** Invalidate cache entries. Pass a model name to invalidate one entry, or omit to clear all. */
  invalidate(model?: string): void {
    if (model) {
      this.cache.delete(model);
    } else {
      this.cache.clear();
    }
  }
}