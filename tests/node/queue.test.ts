import { describe, expect, it } from 'vitest';
import { BridgeQueue } from '@bridge/queue';

describe('BridgeQueue', () => {
  it('starts with zero pending requests', () => {
    const queue = new BridgeQueue();
    expect(queue.getPendingRequestCount()).toBe(0);
  });

  it('increments the pending request count', () => {
    const queue = new BridgeQueue();
    queue.increment();
    expect(queue.getPendingRequestCount()).toBe(1);
  });

  it('increments multiple times', () => {
    const queue = new BridgeQueue();
    queue.increment();
    queue.increment();
    queue.increment();
    expect(queue.getPendingRequestCount()).toBe(3);
  });

  it('decrements the pending request count', () => {
    const queue = new BridgeQueue();
    queue.increment();
    queue.increment();
    expect(queue.getPendingRequestCount()).toBe(2);

    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(1);
  });

  it('decrements back to zero', () => {
    const queue = new BridgeQueue();
    queue.increment();
    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(0);
  });

  it('does not go below zero on decrement', () => {
    const queue = new BridgeQueue();
    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(0);

    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(0);
  });

  it('does not go below zero after multiple decrements without increments', () => {
    const queue = new BridgeQueue();
    queue.decrement();
    queue.decrement();
    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(0);
  });

  it('does not go below zero when decrement exceeds increment', () => {
    const queue = new BridgeQueue();
    queue.increment();
    queue.increment();

    queue.decrement();
    queue.decrement();
    queue.decrement();

    expect(queue.getPendingRequestCount()).toBe(0);
  });

  it('tracks count correctly after a series of increments and decrements', () => {
    const queue = new BridgeQueue();

    // Simulate: 5 jobs queued, 2 complete, 3 more queued, 4 more complete
    queue.increment();
    queue.increment();
    queue.increment();
    queue.increment();
    queue.increment();
    expect(queue.getPendingRequestCount()).toBe(5);

    queue.decrement();
    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(3);

    queue.increment();
    queue.increment();
    queue.increment();
    expect(queue.getPendingRequestCount()).toBe(6);

    queue.decrement();
    queue.decrement();
    queue.decrement();
    queue.decrement();
    expect(queue.getPendingRequestCount()).toBe(2);
  });

  it('maintains independent counts for separate queue instances', () => {
    const queueA = new BridgeQueue();
    const queueB = new BridgeQueue();

    queueA.increment();
    queueA.increment();
    queueB.increment();

    expect(queueA.getPendingRequestCount()).toBe(2);
    expect(queueB.getPendingRequestCount()).toBe(1);
  });

  it('resets to zero correctly after equal increments and decrements', () => {
    const queue = new BridgeQueue();

    for (let i = 0; i < 100; i++) {
      queue.increment();
    }
    expect(queue.getPendingRequestCount()).toBe(100);

    for (let i = 0; i < 100; i++) {
      queue.decrement();
    }
    expect(queue.getPendingRequestCount()).toBe(0);
  });
});