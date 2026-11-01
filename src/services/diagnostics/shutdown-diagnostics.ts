import { createHash, randomUUID } from "node:crypto";
import { Effect, Exit } from "effect";

export interface ShutdownRecord {
  readonly timestamp: string;
  readonly run: string;
  readonly event: "started" | "completed" | "failed" | "interrupted" | "pending" | "cancelled";
  readonly operation: string;
  readonly id?: number;
  readonly resource?: string;
  readonly elapsedMs: number;
  readonly pendingCount?: number;
  readonly omitted?: number;
  readonly pending?: ReadonlyArray<{
    readonly id: number;
    readonly operation: string;
    readonly resource?: string;
    readonly elapsedMs: number;
  }>;
}

/** Never log raw session IDs, paths, server names, arguments or errors. */
export const shutdownResource = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

/**
 * Process-owned observation only: no joins, cancellation, or resource ownership.
 * Tracks callback/Promise SDK work as well as Effects, including work begun before
 * quit. The registry contains metadata, not Fibers or a second task scheduler.
 */
export class ShutdownDiagnostics {
  private readonly run = randomUUID();
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { operation: string; resource?: string; started: number }
  >();
  private active: { started: number; write: (record: ShutdownRecord) => void } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  start(write: (record: ShutdownRecord) => void) {
    if (this.active) return;
    this.active = { started: performance.now(), write };
    this.emit("started", "shutdown", 0);
    this.reportPending();
    // Native callback instrumentation must survive runtime disposal, but must
    // never keep Electron alive. No timer exists during ordinary operation.
    this.timer = setInterval(() => this.reportPending(), 10_000);
    this.timer.unref();
  }

  finish(event: "completed" | "failed" | "cancelled") {
    if (!this.active) return;
    this.emit(event, "shutdown", performance.now() - this.active.started);
    clearInterval(this.timer);
    this.timer = undefined;
    this.active = undefined;
  }

  begin(operation: string, resource?: string) {
    const id = ++this.nextId;
    const started = performance.now();
    this.pending.set(id, { operation, resource, started });
    this.emit("started", operation, 0, { id, resource });
    return (event: "completed" | "failed" | "interrupted") => {
      this.pending.delete(id);
      this.emit(event, operation, performance.now() - started, { id, resource });
    };
  }

  sync<A>(operation: string, resource: string | undefined, work: () => A): A {
    const end = this.begin(operation, resource);
    try {
      const result = work();
      end("completed");
      return result;
    } catch (error) {
      end("failed");
      throw error;
    }
  }

  async promise<A>(
    operation: string,
    resource: string | undefined,
    work: () => A | PromiseLike<A>,
  ): Promise<A> {
    const end = this.begin(operation, resource);
    try {
      const result = await work();
      end("completed");
      return result;
    } catch (error) {
      end("failed");
      throw error;
    }
  }

  effect<A, E, R>(
    operation: string,
    resource: string | undefined,
    work: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      const end = this.begin(operation, resource);
      return work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            end(
              Exit.isSuccess(exit)
                ? "completed"
                : Exit.hasInterrupts(exit)
                  ? "interrupted"
                  : "failed",
            ),
          ),
        ),
      );
    });
  }

  private reportPending() {
    if (!this.active) return;
    const now = performance.now();
    const pending = [...this.pending.entries()].slice(0, 50).map(([id, entry]) => ({
      id,
      operation: entry.operation,
      resource: entry.resource,
      elapsedMs: Math.round(now - entry.started),
    }));
    this.emit("pending", "shutdown", now - this.active.started, {
      pendingCount: this.pending.size,
      omitted: this.pending.size - pending.length,
      pending,
    });
  }

  private emit(
    event: ShutdownRecord["event"],
    operation: string,
    elapsedMs: number,
    fields: Partial<ShutdownRecord> = {},
  ) {
    if (!this.active) return;
    // Diagnostic I/O must not turn a successful cleanup into a failed cleanup.
    try {
      this.active.write({
        timestamp: new Date().toISOString(),
        run: this.run,
        event,
        operation,
        elapsedMs: Math.round(elapsedMs),
        ...fields,
      });
    } catch {
      // The production sink reports its own failures to the console.
    }
  }
}

export const shutdownDiagnostics = new ShutdownDiagnostics();
