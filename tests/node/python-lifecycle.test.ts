import { afterEach, describe, expect, it, vi } from 'vitest';
import { PythonServerManager } from '@bridge/python/lifecycle';
import { createLogger } from '@bridge/logging/logger';

describe('PythonServerManager', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('requests graceful shutdown for a reachable reused Python worker', async () => {
    let healthChecks = 0;
    const fetchMock = vi.fn((input: URL | Request | string) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.endsWith('/health')) {
        healthChecks += 1;

        if (healthChecks >= 2) {
          throw new Error('worker offline');
        }

        return Promise.resolve(
          new Response(
          JSON.stringify({
            status: 'ok',
            model_manager: null,
            vram: null,
            queue: { pending: 0, active: 0 }
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
        );
      }

      if (url.endsWith('/shutdown')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'shutting-down' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        );
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    global.fetch = fetchMock as typeof global.fetch;

    const manager = new PythonServerManager(
      'E:/OllamaDesktop',
      createLogger('python-lifecycle-test'),
      8765
    );

    await manager.stop();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/health' }),
      expect.anything()
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/shutdown' }),
      expect.objectContaining({
        method: 'POST'
      })
    );
  });
});
