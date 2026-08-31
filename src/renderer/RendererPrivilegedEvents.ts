import { Effect, Stream } from "effect";
import { z } from "zod";
import { CakeIpcClient } from "../ipc/client/CakeIpcClient";
import { desktopEventSchema, type DesktopEvent } from "../ipc/desktop-ipc";
import type { RendererRuntime } from "./RendererRuntime";

const privilegedReadySchema = z.object({ type: z.literal("privileged-stream-ready") });

/** Window-owned bridge from the privileged RPC event Stream to legacy event consumers. */
export class RendererPrivilegedEvents implements Disposable {
  private readonly abort = new AbortController();
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(runtime: RendererRuntime) {
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const consume = Effect.flatMap(CakeIpcClient, (client) =>
      client.privileged.observe().pipe(
        Stream.runForEach((input) =>
          Effect.sync(() => {
            if (privilegedReadySchema.safeParse(input).success) {
              resolveReady();
              return;
            }
            const event = desktopEventSchema.parse(input);
            for (const listener of this.listeners) listener(event);
          }),
        ),
      ),
    );
    void runtime.runPromise(consume, { signal: this.abort.signal }).catch(rejectReady);
  }

  subscribe(listener: (event: DesktopEvent) => void) {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.listeners.clear();
  }
}
