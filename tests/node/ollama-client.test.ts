import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@bridge/logging/logger';
import { OllamaClient } from '@bridge/ollama/client';

describe('OllamaClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends an explicit num_ctx on complete chat requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: 'Completed.'
          },
          done: true,
          done_reason: 'stop'
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

    const client = new OllamaClient(createLogger('ollama-client-complete-test'));

    const result = await client.completeChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      numCtx: 50_000,
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    });

    expect(result.content).toBe('Completed.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(typeof requestInit.body).toBe('string');
    const requestBody = requestInit.body as string;
    const body = JSON.parse(requestBody) as {
      options?: { num_ctx?: number };
      stream?: boolean;
    };

    expect(body.stream).toBe(false);
    expect(body.options?.num_ctx).toBe(50_000);
  });

  it('derives num_ctx from message size on streaming chat requests when not provided', async () => {
    const prompt = 'A'.repeat(20_000);
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({
              message: {
                role: 'assistant',
                content: 'Streaming.'
              },
              done: true,
              done_reason: 'stop'
            })}\n`
          )
        );
        controller.close();
      }
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaClient(createLogger('ollama-client-stream-test'));
    const deltas: string[] = [];

    const result = await client.streamChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      onDelta: (delta) => {
        deltas.push(delta);
      }
    });

    expect(result.content).toBe('Streaming.');
    expect(deltas).toEqual(['Streaming.']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(typeof requestInit.body).toBe('string');
    const requestBody = requestInit.body as string;
    const body = JSON.parse(requestBody) as {
      options?: { num_ctx?: number };
      stream?: boolean;
    };

    expect(body.stream).toBe(true);
    expect(body.options?.num_ctx).toBe(7_048);
  });

  it('retries a transient complete-chat fetch failure before succeeding', async () => {
    const transientCause = Object.assign(new Error('socket closed by peer'), {
      code: 'ECONNRESET'
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: transientCause }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: {
              role: 'assistant',
              content: 'Recovered.'
            },
            done: true,
            done_reason: 'stop'
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

    const client = new OllamaClient(createLogger('ollama-client-retry-test'));

    const result = await client.completeChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        }
      ]
    });

    expect(result.content).toBe('Recovered.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('includes the fetch cause in the final complete-chat error after retries are exhausted', async () => {
    const transientCause = Object.assign(new Error('socket closed by peer'), {
      code: 'ECONNRESET'
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new TypeError('fetch failed', {
          cause: transientCause
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaClient(createLogger('ollama-client-error-test'));

    await expect(
      client.completeChat({
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3',
        messages: [
          {
            role: 'user',
            content: 'Hello'
          }
        ]
      })
    ).rejects.toThrow('ECONNRESET');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the non-streaming complete-chat path receives line-delimited JSON', async () => {
    const ndjsonBody = [
      JSON.stringify({
        message: {
          role: 'assistant',
          content: ''
        },
        done: false
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'workspace-lister',
                arguments: {
                  path: '.'
                }
              }
            }
          ]
        },
        done: false
      }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: 'Ready to summarize.'
        },
        done: true,
        done_reason: 'stop'
      })
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(ndjsonBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson'
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaClient(createLogger('ollama-client-ndjson-test'));
    const result = await client.completeChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      messages: [
        {
          role: 'user',
          content: 'Analyze this repository.'
        }
      ]
    });

    expect(result.content).toBe('Ready to summarize.');
    expect(result.doneReason).toBe('stop');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe('workspace-lister');
  });

  it('repairs malformed JSON-like string tool arguments for write calls', async () => {
    const windowsProjectsPath = 'C:\\Users\\<User>\\AppData\\Roaming\\Screenwriter\\projects\\';
    const malformedArguments = `{"filePath":"screenwriter_summary.md","content":"# Screenwriter Summary

- Windows data dir: ${windowsProjectsPath}
- Status indicator: "Unsaved changes" / "Saved"
"}`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'write',
                  arguments: malformedArguments
                }
              }
            ]
          },
          done: true,
          done_reason: 'stop'
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

    const client = new OllamaClient(createLogger('ollama-client-jsonish-tool-args-test'));
    const result = await client.completeChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      messages: [
        {
          role: 'user',
          content: 'Fix the file directly.'
        }
      ]
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.arguments).toEqual({
      filePath: 'screenwriter_summary.md',
      content: `# Screenwriter Summary

- Windows data dir: ${windowsProjectsPath}
- Status indicator: "Unsaved changes" / "Saved"
`
    });
  });

  it('keeps outer JSON tool arguments intact when content contains fenced code blocks', async () => {
    const argumentsWithFences = JSON.stringify({
      filePath: 'screenwriter_summary.md',
      content: [
        '# Screenwriter Summary',
        '',
        '```text',
        'Screenwriter/',
        '+-- src/',
        '+-- package.json',
        '```',
        '',
        '```json',
        '{',
        '  "meta": {',
        '    "app": "electron-screenplay-writer"',
        '  }',
        '}',
        '```',
        ''
      ].join('\n')
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'write',
                  arguments: argumentsWithFences
                }
              }
            ]
          },
          done: true,
          done_reason: 'stop'
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

    const client = new OllamaClient(createLogger('ollama-client-fenced-json-tool-args-test'));
    const result = await client.completeChat({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3',
      messages: [
        {
          role: 'user',
          content: 'Write the repository summary directly.'
        }
      ]
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.arguments).toEqual({
      filePath: 'screenwriter_summary.md',
      content: [
        '# Screenwriter Summary',
        '',
        '```text',
        'Screenwriter/',
        '+-- src/',
        '+-- package.json',
        '```',
        '',
        '```json',
        '{',
        '  "meta": {',
        '    "app": "electron-screenplay-writer"',
        '  }',
        '}',
        '```',
        ''
      ].join('\n')
    });
  });
});
