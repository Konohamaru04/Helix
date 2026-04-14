export class BridgeQueue {
  #pendingRequestCount = 0;

  increment(): void {
    this.#pendingRequestCount += 1;
  }

  decrement(): void {
    this.#pendingRequestCount = Math.max(0, this.#pendingRequestCount - 1);
  }

  getPendingRequestCount(): number {
    return this.#pendingRequestCount;
  }
}
