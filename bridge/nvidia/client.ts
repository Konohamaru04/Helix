import type { Logger } from 'pino';
import { type NvidiaStatus, nvidiaStatusSchema } from '@bridge/ipc/contracts';
import { listNvidiaChatModels } from '@bridge/nvidia/catalog';
import type {
  OllamaChatCompletion,
  OllamaChatMessage
} from '@bridge/ollama/client';

interface NvidiaChatChoiceDelta {
  content?: string | null;
}

interface NvidiaChatChoiceMessage {
  content?: string | null;
}

interface NvidiaChatChoice {
  delta?: NvidiaChatChoiceDelta;
  message?: NvidiaChatChoiceMessage;
  finish_reason?: string | null;
}

interface NvidiaChatResponsePayload {
  choices?: NvidiaChatChoice[];
  error?: {
    message?: string;
  };
}

const NVIDIA_DEFAULT_MAX_TOKENS = 4096;

function appendApiPath(baseUrl: string, relativePath: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBaseUrl);
}

function stripSsePrefix(value: string): string {
  return value.startsWith('data:') ? value.slice(5).trim() : value.trim();
}

function getErrorMessage(payload: NvidiaChatResponsePayload): string | null {
  const message = payload.error?.message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
}

function parseResponseBody(rawBody: string): OllamaChatCompletion {
  const payload = JSON.parse(rawBody) as NvidiaChatResponsePayload;
  const errorMessage = getErrorMessage(payload);

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const choice = payload.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    doneReason: choice?.finish_reason ?? null,
    thinking: '',
    toolCalls: []
  };
}

function parseSsePayload(value: string): {
  delta: string;
  doneReason: string | null;
  complete: boolean;
} {
  const normalizedValue = stripSsePrefix(value);

  if (!normalizedValue) {
    return {
      delta: '',
      doneReason: null,
      complete: false
    };
  }

  if (normalizedValue === '[DONE]') {
    return {
      delta: '',
      doneReason: 'stop',
      complete: true
    };
  }

  const payload = JSON.parse(normalizedValue) as NvidiaChatResponsePayload;
  const errorMessage = getErrorMessage(payload);

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const choice = payload.choices?.[0];

  return {
    delta: choice?.delta?.content ?? '',
    doneReason: choice?.finish_reason ?? null,
    complete: false
  };
}

function mapMessages(messages: OllamaChatMessage[]): Array<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}> {
  return messages.map((message) => {
    if (message.images && message.images.length > 0) {
      throw new Error(
        'NVIDIA text chat is configured, but image attachments are only supported on the Ollama path in this build.'
      );
    }

    if (message.role === 'tool') {
      throw new Error(
        'NVIDIA text chat does not support native tool-loop messages in this build.'
      );
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

export class NvidiaClient {
  constructor(private readonly logger: Logger) {}

  getStatus(baseUrl: string, apiKey: string): Promise<NvidiaStatus> {
    const configured = apiKey.trim().length > 0;

    return Promise.resolve(
      nvidiaStatusSchema.parse({
        configured,
        baseUrl,
        checkedAt: new Date().toISOString(),
        error: configured ? null : 'Add an NVIDIA API key in Settings to use this backend.',
        models: listNvidiaChatModels()
      })
    );
  }

  async streamChat(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: OllamaChatMessage[];
    onDelta: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<OllamaChatCompletion> {
    const response = await fetch(appendApiPath(input.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`
      },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        model: input.model,
        messages: mapMessages(input.messages),
        max_tokens: NVIDIA_DEFAULT_MAX_TOKENS,
        stream: true
      })
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text();
      throw new Error(
        `NVIDIA chat failed with ${response.status}: ${errorBody || 'no response body'}`
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let doneReason: string | null = null;

    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      if (!chunk.value) {
        continue;
      }

      const chunkValue = chunk.value as Uint8Array;
      buffer += decoder.decode(chunkValue, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseSsePayload(line);

        if (parsed.delta) {
          content += parsed.delta;
          input.onDelta(parsed.delta);
        }

        if (parsed.doneReason !== null) {
          doneReason = parsed.doneReason;
        }

        if (parsed.complete) {
          break;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const parsed = parseSsePayload(buffer);

      if (parsed.delta) {
        content += parsed.delta;
        input.onDelta(parsed.delta);
      }

      if (parsed.doneReason !== null) {
        doneReason = parsed.doneReason;
      }
    }

    return {
      content,
      doneReason,
      thinking: '',
      toolCalls: []
    };
  }

  async completeChat(input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: OllamaChatMessage[];
    signal?: AbortSignal;
  }): Promise<OllamaChatCompletion> {
    const response = await fetch(appendApiPath(input.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`
      },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        model: input.model,
        messages: mapMessages(input.messages),
        max_tokens: NVIDIA_DEFAULT_MAX_TOKENS,
        stream: false
      })
    });
    const rawBody = await response.text();

    if (!response.ok) {
      this.logger.warn(
        {
          model: input.model,
          status: response.status,
          body: rawBody.slice(0, 600)
        },
        'NVIDIA completion request failed'
      );
      throw new Error(`NVIDIA chat failed with ${response.status}: ${rawBody || 'no response body'}`);
    }

    return parseResponseBody(rawBody);
  }
}
