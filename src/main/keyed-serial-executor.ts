/** Serializes work per key while allowing unrelated keys to proceed concurrently. */
export class KeyedSerialExecutor<Key> {
  private readonly pending = new Map<Key, Promise<unknown>>();

  run<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }
}
