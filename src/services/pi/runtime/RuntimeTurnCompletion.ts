/** Correlates accepted Pi input with consumption and the actual settled run. */
export class RuntimeTurnCompletion {
  private readonly pending = new Map<
    string,
    {
      content: string;
      consumed: boolean;
      mayTransform: boolean;
      resolve(): void;
      reject(error: Error): void;
    }
  >();

  track(id: string, content: string, mayTransform = false) {
    const completion = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { content, consumed: false, mayTransform, resolve, reject });
    });
    // Delivery can still be awaiting Pi when an abort rejects its completion.
    void completion.catch(() => undefined);
    return completion;
  }

  consume(content: string) {
    const waiting = [...this.pending.values()].filter((item) => !item.consumed);
    const entry =
      waiting.find((item) => item.content === content) ?? waiting.find((item) => item.mayTransform);
    if (entry) entry.consumed = true;
  }

  executingIds() {
    return [...this.pending].filter(([, item]) => item.consumed).map(([id]) => id);
  }

  settle() {
    for (const [id, item] of this.pending) {
      if (!item.consumed) continue;
      this.pending.delete(id);
      item.resolve();
    }
  }

  forget(id: string) {
    this.pending.delete(id);
  }

  finishHandledInput(id: string) {
    this.pending.get(id)?.resolve();
    this.pending.delete(id);
  }

  cancel(queuedOnly = false) {
    for (const [id, item] of this.pending) {
      if (queuedOnly && item.consumed) continue;
      this.pending.delete(id);
      item.reject(new Error(queuedOnly ? "Queued input was canceled" : "Session was aborted"));
    }
  }
}
