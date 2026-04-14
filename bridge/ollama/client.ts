import type { Logger } from 'pino';
import { parseJsonishRecord } from '@bridge/jsonish';
import { ollamaStatusSchema, type OllamaStatus } from '@bridge/ipc/contracts';

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    size?: number;
    digest?: string;
  }>;
}

interface OllamaStreamChunk {
  message?: {
    role?: 'assistant';
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

interface OllamaChatResponsePayload {
  message?: {
    role?: 'assistant';
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

export interface OllamaToolCall {
  type: 'function';
  function: {
    index?: number;
    name: string;
    description?: string;
    arguments: Record<string, unknown>;
  };
}

const OLLAMA_CHAT_FETCH_MAX_ATTEMPTS = 2;
const OLLAMA_CHAT_FETCH_RETRY_DELAY_MS = 750;
const MIN_DYNAMIC_OLLAMA_NUM_CTX = 4_096;
const MAX_FALLBACK_OLLAMA_NUM_CTX = 131_072;

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  thinking?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaChatCompletion {
  content: string;
  doneReason: string | null;
  thinking: string;
  toolCalls: OllamaToolCall[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  const recordValue = asRecord(value);

  if (recordValue) {
    return recordValue;
  }

  if (typeof value !== 'string') {
    return {};
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return {};
  }

  const parsedRecord = parseJsonishRecord(trimmedValue);

  if (parsedRecord) {
    return parsedRecord;
  }

  try {
    const parsed = JSON.parse(trimmedValue) as unknown;

    if (typeof parsed === 'string' && parsed.trim()) {
      return { __raw: parsed.trim() };
    }
  } catch {
    // Fall back to the raw string when a model returns non-JSON tool input.
  }

  return { __raw: trimmedValue };
}

function parseToolCalls(value: unknown): OllamaToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const itemRecord = asRecord(item);

    if (!itemRecord) {
      return [];
    }

    const functionPayload = asRecord(itemRecord.function);
    const name =
      functionPayload && typeof functionPayload.name === 'string'
        ? functionPayload.name.trim()
        : '';

    if (!name) {
      return [];
    }

    const argumentsValue = functionPayload
      ? parseToolArguments(functionPayload.arguments)
      : {};
    const description =
      functionPayload && typeof functionPayload.description === 'string'
        ? functionPayload.description
        : undefined;
    const index =
      functionPayload && typeof functionPayload.index === 'number'
        ? functionPayload.index
        : undefined;

    return [
      {
        type: 'function' as const,
        function: {
          ...(index === undefined ? {} : { index }),
          name,
          ...(description ? { description } : {}),
          arguments: argumentsValue
        }
      }
    ];
  });
}

function stripStreamingPrefix(value: string): string {
  return value.startsWith('data:') ? value.slice(5).trim() : value;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.trim().length / 4));
}

function estimateMessageTokens(messages: OllamaChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

function resolveFallbackNumCtx(messages: OllamaChatMessage[]): number {
  const promptTokens = estimateMessageTokens(messages);
  const headroom = Math.max(2_048, Math.ceil(promptTokens * 0.25));

  return Math.min(
    MAX_FALLBACK_OLLAMA_NUM_CTX,
    Math.max(MIN_DYNAMIC_OLLAMA_NUM_CTX, promptTokens + headroom)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function readErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : null;
}

function readErrorMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const causeCode = readErrorCode(error.cause);
  const causeMessage = readErrorMessage(error.cause);

  if (causeCode && causeMessage) {
    return `${error.message} (${causeCode}: ${causeMessage})`;
  }

  if (causeCode) {
    return `${error.message} (${causeCode})`;
  }

  if (causeMessage) {
    return `${error.message} (${causeMessage})`;
  }

  return error.message;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return false;
  }

  const retryableCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT'
  ]);
  const errorCode = readErrorCode(error);
  const causeCode = readErrorCode(error.cause);

  if (
    (errorCode && retryableCodes.has(errorCode)) ||
    (causeCode && retryableCodes.has(causeCode))
  ) {
    return true;
  }

  const normalizedMessage = error.message.toLowerCase();
  return (
    normalizedMessage.includes('fetch failed') ||
    normalizedMessage.includes('network') ||
    normalizedMessage.includes('socket') ||
    normalizedMessage.includes('timeout')
  );
}

export class OllamaClient {
  constructor(private readonly logger: Logger) {}

  async getStatus(baseUrl: string): Promise<OllamaStatus> {
    const checkedAt = new Date().toISOString();

    try {
      const response = await fetch(new URL('/api/tags', baseUrl), {
        method: 'GET'
      });

      if (!response.ok) {
        throw new Error(`Ollama responded with ${response.status}.`);
      }

      const payload = (await response.json()) as OllamaTagsResponse;

      return ollamaStatusSchema.parse({
        reachable: true,
        baseUrl,
        checkedAt,
        error: null,
        models: (payload.models ?? [])
          .filter((model) => typeof model.name === 'string' && model.name.length > 0)
          .map((model) => ({
            name: model.name as string,
            size: typeof model.size === 'number' ? model.size : null,
            digest: typeof model.digest === 'string' ? model.digest : null
          }))
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Ollama error';
      this.logger.warn({ baseUrl, error: message }, 'Ollama connectivity check failed');

      return ollamaStatusSchema.parse({
        reachable: false,
        baseUrl,
        checkedAt,
        error: message,
        models: []
      });
    }
  }

  async streamChat(input: {
    baseUrl: string;
    model: string;
    messages: OllamaChatMessage[];
    tools?: OllamaToolDefinition[];
    think?: boolean | 'low' | 'medium' | 'high';
    numCtx?: number;
    onDelta: (delta: string) => void;
    onThinkingDelta?: ((delta: string) => void) | undefined;
    onToolCalls?: ((toolCalls: OllamaToolCall[]) => void) | undefined;
    signal?: AbortSignal;
  }): Promise<OllamaChatCompletion> {
    const response = await this.fetchChatWithRetry({
      baseUrl: input.baseUrl,
      model: input.model,
      signal: input.signal,
      requestInit: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: input.signal ?? null,
        body: JSON.stringify(
          this.buildChatRequestBody({
            model: input.model,
            stream: true,
            messages: input.messages,
            ...(input.numCtx === undefined ? {} : { numCtx: input.numCtx }),
            ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
            ...(input.think !== undefined ? { think: input.think } : {})
          })
        )
      },
      stream: true
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama chat failed with ${response.status}: ${errorBody || 'no response body'}`
      );
    }

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneReason: string | null = null;
    let content = '';
    let thinking = '';
    const toolCalls: OllamaToolCall[] = [];

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      const value = chunk.value;

      if (!value) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const processed = this.processStreamLine(line);

        if (processed.delta) {
          content += processed.delta;
          input.onDelta(processed.delta);
        }

        if (processed.thinkingDelta) {
          thinking += processed.thinkingDelta;
          input.onThinkingDelta?.(processed.thinkingDelta);
        }

        if (processed.toolCalls.length > 0) {
          toolCalls.push(...processed.toolCalls);
          input.onToolCalls?.(processed.toolCalls);
        }

        doneReason = processed.doneReason ?? doneReason;
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const processed = this.processStreamLine(buffer);

      if (processed.delta) {
        content += processed.delta;
        input.onDelta(processed.delta);
      }

      if (processed.thinkingDelta) {
        thinking += processed.thinkingDelta;
        input.onThinkingDelta?.(processed.thinkingDelta);
      }

      if (processed.toolCalls.length > 0) {
        toolCalls.push(...processed.toolCalls);
        input.onToolCalls?.(processed.toolCalls);
      }

      doneReason = processed.doneReason ?? doneReason;
    }

    return {
      content,
      doneReason,
      thinking,
      toolCalls
    };
  }

  async completeChat(input: {
    baseUrl: string;
    model: string;
    messages: OllamaChatMessage[];
    tools?: OllamaToolDefinition[];
    think?: boolean | 'low' | 'medium' | 'high';
    numCtx?: number;
    signal?: AbortSignal;
  }): Promise<OllamaChatCompletion> {
    const response = await this.fetchChatWithRetry({
      baseUrl: input.baseUrl,
      model: input.model,
      signal: input.signal,
      requestInit: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        signal: input.signal ?? null,
        body: JSON.stringify(
          this.buildChatRequestBody({
            model: input.model,
            stream: true,
            messages: input.messages,
            ...(input.numCtx === undefined ? {} : { numCtx: input.numCtx }),
            ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
            ...(input.think !== undefined ? { think: input.think } : {})
          })
        )
      },
      stream: true
    });

    const rawBody = await response.text();

    if (!response.ok) {
      throw new Error(`Ollama chat failed with ${response.status}: ${rawBody || 'no response body'}`);
    }

    return this.parseCompleteChatBody(rawBody);
  }

  private processStreamLine(line: string): {
    delta: string;
    thinkingDelta: string;
    toolCalls: OllamaToolCall[];
    doneReason: string | null;
  } {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      return {
        delta: '',
        thinkingDelta: '',
        toolCalls: [],
        doneReason: null
      };
    }

    const payload = JSON.parse(trimmedLine) as OllamaStreamChunk;

    if (payload.error) {
      throw new Error(payload.error);
    }

    return {
      delta: payload.message?.content ?? '',
      thinkingDelta: payload.message?.thinking ?? '',
      toolCalls: parseToolCalls(payload.message?.tool_calls),
      doneReason: payload.done ? payload.done_reason ?? null : null
    };
  }

  private parseCompleteChatBody(rawBody: string): OllamaChatCompletion {
    const trimmedBody = rawBody.trim();

    if (!trimmedBody) {
      return {
        content: '',
        doneReason: null,
        thinking: '',
        toolCalls: []
      };
    }

    try {
      const payload = JSON.parse(trimmedBody) as OllamaChatResponsePayload;
      return this.toChatCompletion(payload);
    } catch (error) {
      const lines = trimmedBody
        .split(/\r?\n/)
        .map((line) => stripStreamingPrefix(line.trim()))
        .filter(Boolean);

      if (lines.length <= 1) {
        throw error;
      }

      let content = '';
      let thinking = '';
      let doneReason: string | null = null;
      const toolCalls: OllamaToolCall[] = [];

      for (const line of lines) {
        const processed = this.processStreamLine(line);
        content += processed.delta;
        thinking += processed.thinkingDelta;

        if (processed.toolCalls.length > 0) {
          toolCalls.push(...processed.toolCalls);
        }

        if (processed.doneReason !== null) {
          doneReason = processed.doneReason;
        }
      }

      this.logger.warn(
        {
          lineCount: lines.length
        },
        'Received line-delimited chat completion payload on the non-streaming Ollama path'
      );

      return {
        content,
        doneReason,
        thinking,
        toolCalls
      };
    }
  }

  private toChatCompletion(payload: OllamaChatResponsePayload): OllamaChatCompletion {
    if (payload.error) {
      throw new Error(payload.error);
    }

    return {
      content: payload.message?.content ?? '',
      doneReason: payload.done ? payload.done_reason ?? null : null,
      thinking: payload.message?.thinking ?? '',
      toolCalls: parseToolCalls(payload.message?.tool_calls)
    };
  }

  private async fetchChatWithRetry(input: {
    baseUrl: string;
    model: string;
    requestInit: RequestInit;
    signal?: AbortSignal | undefined;
    stream: boolean;
  }): Promise<Response> {
    const url = new URL('/api/chat', input.baseUrl);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= OLLAMA_CHAT_FETCH_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await fetch(url, input.requestInit);
      } catch (error) {
        lastError = error;
        const retryable = isRetryableFetchError(error);

        if (!retryable || attempt >= OLLAMA_CHAT_FETCH_MAX_ATTEMPTS || input.signal?.aborted) {
          break;
        }

        this.logger.warn(
          {
            baseUrl: input.baseUrl,
            model: input.model,
            stream: input.stream,
            attempt,
            maxAttempts: OLLAMA_CHAT_FETCH_MAX_ATTEMPTS,
            error: formatFetchError(error)
          },
          'Ollama chat request failed before a response; retrying'
        );

        await delay(OLLAMA_CHAT_FETCH_RETRY_DELAY_MS);
      }
    }

    throw new Error(`Ollama chat request failed: ${formatFetchError(lastError)}`, {
      cause: lastError instanceof Error ? lastError : undefined
    });
  }

  private buildChatRequestBody(input: {
    model: string;
    stream: boolean;
    messages: OllamaChatMessage[];
    tools?: OllamaToolDefinition[];
    think?: boolean | 'low' | 'medium' | 'high';
    numCtx?: number;
  }): Record<string, unknown> {
    return {
      model: input.model,
      stream: input.stream,
      messages: input.messages,
      options: {
        num_ctx: input.numCtx ?? resolveFallbackNumCtx(input.messages)
      },
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(input.think !== undefined ? { think: input.think } : {})
    };
  }
}
