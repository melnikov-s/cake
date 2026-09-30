import { onSnapshot, toSnapshot, type Store } from "r-state-tree";
import type { JsonValue } from "../../ipc/json-contract";
import type { Client } from "../client/Client";
import { extractSavedDrafts } from "../../services/storage/WindowStateStorage";

/** One-way mounted Store snapshot persistence owned by the renderer window. */
export class WindowStatePersistence implements Disposable {
  private root: Store | undefined;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly client: Client,
    private readonly reportError: (error: unknown) => void,
    private readonly savedDraftsReady = false,
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
    // Store snapshots are plain data, but may contain undefined and non-finite numbers.
    // Keep JSON normalization and capture isolation before queueing. Parsing our own JSON
    // needs no further tree validation here; the RPC and storage boundaries still validate.
    const snapshot: JsonValue = JSON.parse(JSON.stringify(toSnapshot(root)));
    // After migration commits, this window persists only unsent navigation/composer state.
    const windowSnapshot = this.savedDraftsReady
      ? extractSavedDrafts(snapshot).windowSnapshot
      : snapshot;
    this.saveQueue = this.saveQueue
      .then(() => {
        if (!this.disposed) return this.client.windowState.save(windowSnapshot);
      })
      .catch((error) => {
        if (!this.disposed) this.reportError(error);
      });
    return this.saveQueue;
  }
}
