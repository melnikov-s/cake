import { RpcClientError } from "effect/unstable/rpc";

const initialRetryDelayMs = 250;
const maximumRetryDelayMs = 30_000;

export type SynchronizationFailureAction = "retry" | "stop";

export interface SynchronizationRegistration {
  readonly run: (signal: AbortSignal, markHealthy: () => void) => Promise<void>;
  readonly classifyFailure?: (error: unknown) => SynchronizationFailureAction;
  readonly reportFailure: (error: unknown) => void;
}

interface ActiveSynchronization extends SynchronizationRegistration {
  abort: AbortController;
  generation: number;
  retryAttempts: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  failureReported: boolean;
  healthyConnectionGeneration: number | undefined;
}

/** Window-owned retry and reconnect policy shared by every renderer subscription. */
export class RendererSynchronizationSupervisor implements Disposable {
  private readonly synchronizations = new Map<string, ActiveSynchronization>();
  private connectionGeneration = 0;
  private connectionRetryAttempts = 0;
  private connectionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  register(key: string, registration: SynchronizationRegistration) {
    if (this.disposed) return;
    if (this.synchronizations.has(key))
      throw new Error(`Renderer synchronization already registered: ${key}`);
    const active: ActiveSynchronization = {
      ...registration,
      abort: new AbortController(),
      generation: 0,
      retryAttempts: 0,
      retryTimer: undefined,
      failureReported: false,
      healthyConnectionGeneration: undefined,
    };
    this.synchronizations.set(key, active);
    this.start(key, active);
  }

  unregister(key: string) {
    const active = this.synchronizations.get(key);
    if (!active) return;
    active.abort.abort();
    if (active.retryTimer) clearTimeout(active.retryTimer);
    this.synchronizations.delete(key);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.connectionRetryTimer) clearTimeout(this.connectionRetryTimer);
    this.connectionRetryTimer = undefined;
    for (const active of this.synchronizations.values()) {
      active.abort.abort();
      if (active.retryTimer) clearTimeout(active.retryTimer);
    }
    this.synchronizations.clear();
  }

  private start(key: string, active: ActiveSynchronization) {
    if (this.disposed || this.synchronizations.get(key) !== active) return;
    active.abort.abort();
    if (active.retryTimer) clearTimeout(active.retryTimer);
    active.abort = new AbortController();
    active.retryTimer = undefined;
    active.generation += 1;
    active.healthyConnectionGeneration = undefined;
    const generation = active.generation;
    void active
      .run(active.abort.signal, () => this.markHealthy(key, active, generation))
      .catch((error) => this.handleFailure(key, active, generation, error));
  }

  private markHealthy(key: string, active: ActiveSynchronization, generation: number) {
    if (
      this.disposed ||
      this.synchronizations.get(key) !== active ||
      generation !== active.generation
    )
      return;
    active.retryAttempts = 0;
    active.failureReported = false;
    active.healthyConnectionGeneration = this.connectionGeneration;
    if (
      [...this.synchronizations.values()].every(
        (candidate) => candidate.healthyConnectionGeneration === this.connectionGeneration,
      )
    )
      this.connectionRetryAttempts = 0;
  }

  private handleFailure(
    key: string,
    active: ActiveSynchronization,
    generation: number,
    error: unknown,
  ) {
    if (
      this.disposed ||
      this.synchronizations.get(key) !== active ||
      generation !== active.generation ||
      active.abort.signal.aborted
    )
      return;
    if (error instanceof RpcClientError.RpcClientError) {
      this.scheduleConnectionReconnect(active, error);
      return;
    }
    const action = active.classifyFailure?.(error) ?? "retry";
    if (action === "stop") {
      this.reportOnce(active, error);
      this.unregister(key);
      return;
    }
    this.reportOnce(active, error);
    this.scheduleRetry(key, active);
  }

  private reportOnce(active: ActiveSynchronization, error: unknown) {
    if (active.failureReported) return;
    active.failureReported = true;
    active.reportFailure(error);
  }

  private scheduleRetry(key: string, active: ActiveSynchronization) {
    if (active.retryTimer) return;
    active.abort.abort();
    const delay = retryDelay(active.retryAttempts);
    active.retryAttempts += 1;
    active.retryTimer = setTimeout(() => this.start(key, active), delay);
  }

  private scheduleConnectionReconnect(origin: ActiveSynchronization, error: unknown) {
    if (this.connectionRetryTimer) return;
    this.reportOnce(origin, error);
    for (const active of this.synchronizations.values()) {
      active.abort.abort();
      if (active.retryTimer) clearTimeout(active.retryTimer);
      active.retryTimer = undefined;
      active.healthyConnectionGeneration = undefined;
    }
    const delay = retryDelay(this.connectionRetryAttempts);
    this.connectionRetryAttempts += 1;
    this.connectionRetryTimer = setTimeout(() => {
      this.connectionRetryTimer = undefined;
      if (this.disposed) return;
      this.connectionGeneration += 1;
      for (const [key, active] of this.synchronizations) this.start(key, active);
    }, delay);
  }
}

const retryDelay = (attempt: number) =>
  Math.min(initialRetryDelayMs * 2 ** attempt, maximumRetryDelayMs);
