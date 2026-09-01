import { Schema } from "effect";
import { onSnapshot, toSnapshot, type Store } from "r-state-tree";
import { jsonValueSchema } from "../ipc/json-contract";
import type { RendererClient } from "./client/RendererClient";

/** One-way mounted Store snapshot persistence owned by the renderer window. */
export class WindowStatePersistence implements Disposable {
  private root: Store | undefined;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly client: RendererClient,
    private readonly reportError: (error: unknown) => void,
  ) {}

  observe(root: Store) {
    if (this.unsubscribe) throw new Error("Window State persistence is already observing a Store");
    this.root = root;
    this.unsubscribe = onSnapshot(root, () => this.schedule());
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.root ? this.enqueue(this.root) : Promise.resolve();
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.root) void this.enqueue(this.root);
    }, 180);
  }

  private enqueue(root: Store) {
    const snapshot = Schema.decodeUnknownSync(jsonValueSchema)(
      JSON.parse(JSON.stringify(toSnapshot(root))),
    );
    this.saveQueue = this.saveQueue
      .then(() => {
        if (!this.disposed) return this.client.windowState.save(snapshot);
      })
      .catch((error) => {
        if (!this.disposed) this.reportError(error);
      });
    return this.saveQueue;
  }
}
