import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type StreamFunction = AgentSession["agent"]["streamFunction"];

export const RATE_LIMIT_RETRY_DELAYS_MS = [
  1_000, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
] as const;
export const RATE_LIMIT_RETRY_MAX_ELAPSED_MS = 24 * 60 * 60 * 1_000;

export interface RateLimitRetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

interface RateLimitRetryOptions {
  enabled(): boolean;
  onRetry(notice: RateLimitRetryNotice): void;
  onFinished(): void;
  delaysMs?: readonly number[];
  maxElapsedMs?: number;
}

function retryPlan(delaysMs: readonly number[], maxElapsedMs: number) {
  const usableDelays = delaysMs.filter((delay) => Number.isFinite(delay) && delay >= 0);
  if (usableDelays.length === 0 || maxElapsedMs <= 0)
    return { delaysMs: usableDelays, maxAttempts: 0 };

  let elapsedMs = 0;
  let maxAttempts = 0;
  for (const delayMs of usableDelays) {
    if (elapsedMs + delayMs > maxElapsedMs) return { delaysMs: usableDelays, maxAttempts };
    elapsedMs += delayMs;
    maxAttempts += 1;
  }
  const repeatedDelayMs = usableDelays.at(-1)!;
  if (repeatedDelayMs > 0) maxAttempts += Math.floor((maxElapsedMs - elapsedMs) / repeatedDelayMs);
  return { delaysMs: usableDelays, maxAttempts };
}

function isRateLimit(message: AssistantMessage) {
  return (
    isRetryableAssistantError(message) &&
    /(?:429|rate.?limit|too many requests)/i.test(message.errorMessage ?? "")
  );
}

function isEmptyRateLimit(message: AssistantMessage, meaningfulOutput: boolean) {
  return !meaningfulOutput && message.content.length === 0 && isRateLimit(message);
}

function nonReplayableRateLimitMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage:
      "Provider throttling occurred after response output began. Cake stopped to avoid replaying work.",
  };
}

function abortedMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: [],
    stopReason: "aborted",
    errorMessage: "Request aborted",
  };
}

function exhaustedMessage(message: AssistantMessage, attempts: number): AssistantMessage {
  return {
    ...message,
    content: [],
    stopReason: "error",
    errorMessage: `Automatic provider-throttling retries stopped after the retry window (${attempts} ${attempts === 1 ? "retry" : "retries"}).`,
  };
}

export class RateLimitRetryController {
  private readonly waits = new Set<AbortController>();
  private readonly options: RateLimitRetryOptions;
  private readonly plan: ReturnType<typeof retryPlan>;
  private readonly maxElapsedMs: number;

  constructor(options: RateLimitRetryOptions) {
    this.options = options;
    this.maxElapsedMs = options.maxElapsedMs ?? RATE_LIMIT_RETRY_MAX_ELAPSED_MS;
    this.plan = retryPlan(options.delaysMs ?? RATE_LIMIT_RETRY_DELAYS_MS, this.maxElapsedMs);
  }

  wrap(baseStream: StreamFunction): StreamFunction {
    return (model, context, streamOptions) => {
      const output = createAssistantMessageEventStream();
      void this.forwardWithRetries(baseStream, model, context, streamOptions, output);
      return output;
    };
  }

  cancel() {
    for (const controller of this.waits) controller.abort();
    this.waits.clear();
  }

  private async forwardWithRetries(
    baseStream: StreamFunction,
    model: Parameters<StreamFunction>[0],
    context: Parameters<StreamFunction>[1],
    streamOptions: Parameters<StreamFunction>[2],
    output: ReturnType<typeof createAssistantMessageEventStream>,
  ) {
    const startedAt = Date.now();
    let retries = 0;
    let forwardedStart = false;
    let meaningfulOutput = false;
    const finish = () => {
      if (retries > 0) this.options.onFinished();
    };

    while (true) {
      const source = await baseStream(model, context, streamOptions);
      let shouldRetry = false;

      for await (const event of source) {
        if (event.type === "start") {
          if (!forwardedStart) {
            output.push(event);
            forwardedStart = true;
          }
          continue;
        }
        if (event.type === "done") {
          output.push(event);
          finish();
          return;
        }
        if (event.type !== "error") {
          meaningfulOutput = true;
          output.push(event);
          continue;
        }

        if (!this.options.enabled()) {
          output.push(event);
          finish();
          return;
        }
        if (isRateLimit(event.error) && !isEmptyRateLimit(event.error, meaningfulOutput)) {
          output.push({
            type: "error",
            reason: "error",
            error: nonReplayableRateLimitMessage(event.error),
          });
          finish();
          return;
        }
        if (!isEmptyRateLimit(event.error, meaningfulOutput)) {
          output.push(event);
          finish();
          return;
        }

        const nextAttempt = retries + 1;
        const delayMs = this.plan.delaysMs[Math.min(retries, this.plan.delaysMs.length - 1)];
        if (
          delayMs === undefined ||
          nextAttempt > this.plan.maxAttempts ||
          Date.now() + delayMs > startedAt + this.maxElapsedMs
        ) {
          output.push({
            type: "error",
            reason: "error",
            error: exhaustedMessage(event.error, retries),
          });
          finish();
          return;
        }

        retries = nextAttempt;
        this.options.onRetry({
          attempt: retries,
          maxAttempts: this.plan.maxAttempts,
          delayMs,
          errorMessage: event.error.errorMessage ?? "Provider rate limit",
        });
        shouldRetry = await this.wait(delayMs, streamOptions?.signal);
        if (!shouldRetry) {
          const stopped = streamOptions?.signal?.aborted
            ? abortedMessage(event.error)
            : event.error;
          output.push({
            type: "error",
            reason: stopped.stopReason === "aborted" ? "aborted" : "error",
            error: stopped,
          });
          finish();
          return;
        }
        break;
      }

      if (!shouldRetry) {
        const final = await source.result();
        if (final.stopReason === "error" || final.stopReason === "aborted")
          output.push({ type: "error", reason: final.stopReason, error: final });
        else if (
          final.stopReason === "stop" ||
          final.stopReason === "length" ||
          final.stopReason === "toolUse" ||
          final.stopReason === "deferred"
        )
          output.push({ type: "done", reason: final.stopReason, message: final });
        else
          output.push({
            type: "error",
            reason: "error",
            error: { ...final, stopReason: "error", errorMessage: "Provider stream ended early" },
          });
        finish();
        return;
      }
    }
  }

  private wait(delayMs: number, signal?: AbortSignal) {
    const controller = new AbortController();
    this.waits.add(controller);
    return new Promise<boolean>((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", abort);
        this.waits.delete(controller);
        resolve(completed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      signal?.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) finish(false);
    });
  }
}
