import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@bridge/logging/logger';
import { NvidiaClient } from '@bridge/nvidia/client';

describe('NvidiaClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses OpenAI-compatible streaming SSE chat responses', async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
              'data: {"choices":[{"delta":{"content":"NVIDIA"},"finish_reason":"stop"}]}',
              'data: [DONE]'
            ].join('\n')
          )
        );
        controller.close();
      }
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream'
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NvidiaClient(createLogger('nvidia-client-stream-test'));
    const deltas: string[] = [];

    const result = await client.streamChat({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-test',
      model: 'meta/llama-3.1-8b-instruct',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ],
      onDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(result.content).toBe('Hello NVIDIA');
    expect(result.doneReason).toBe('stop');
    expect(deltas).toEqual(['Hello ', 'NVIDIA']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(requestInit.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer nvapi-test'
      })
    );
  });

  it('parses non-stream chat responses from the NVIDIA endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Completed.'
              },
              finish_reason: 'stop'
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new NvidiaClient(createLogger('nvidia-client-complete-test'));
    const result = await client.completeChat({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-test',
      model: 'meta/llama-3.1-8b-instruct',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    });

    expect(result.content).toBe('Completed.');
    expect(result.doneReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
  });

  it('rejects image and tool-loop messages until the NVIDIA path supports them', async () => {
    const client = new NvidiaClient(createLogger('nvidia-client-guard-test'));

    await expect(
      client.completeChat({
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'nvapi-test',
        model: 'meta/llama-3.1-8b-instruct',
        messages: [
          {
            role: 'user',
            content: 'Describe this image',
            images: ['ZmFrZQ==']
          }
        ]
      })
    ).rejects.toThrow('image attachments');

    await expect(
      client.completeChat({
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'nvapi-test',
        model: 'meta/llama-3.1-8b-instruct',
        messages: [
          {
            role: 'tool',
            tool_name: 'read',
            content: 'file contents'
          }
        ]
      })
    ).rejects.toThrow('native tool-loop');
  });
});
