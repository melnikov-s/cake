import { Store, untracked } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";

const ANTHROPIC_SHORT_TTL_MS = 5 * 60 * 1_000;
const ANTHROPIC_LONG_TTL_MS = 60 * 60 * 1_000;
const OPENAI_LIKELY_WARM_MS = 5 * 60 * 1_000;
const OPENAI_LIKELY_COLD_MS = 10 * 60 * 1_000;
const OPENAI_MIN_CACHEABLE_TOKENS = 1_024;

type PromptCacheResponse = NonNullable<Extract<UiPart, { kind: "text" }>["response"]>;

type PromptCachePrediction = {
  state: "likely-warm" | "uncertain" | "likely-cold";
  label: string;
  detail: string;
  remainingMs?: number;
};

/** Owns the deliberately conservative, provider-specific prompt-cache countdown. */
export class PromptCacheStore extends Store<{
  parts(): readonly UiPart[];
  model(): { provider: string; modelId: string } | undefined;
}> {
  private now = Date.now();
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(props: PromptCacheStore["props"]) {
    super(props);
    untracked(() => this.updateTick(this.shouldTick));
    this.reaction(
      () => this.shouldTick,
      (active) => this.updateTick(active),
    );
    this.effect(() => () => this.stopTick());
  }

  get prediction(): PromptCachePrediction | undefined {
    const model = this.props.model();
    if (!model) return undefined;
    const response = this.latestResponse(model);
    if (!response) return undefined;

    if (model.provider === "anthropic" || model.provider === "amazon-bedrock") {
      if (response.cacheReadTokens + response.cacheWriteTokens === 0) return undefined;
      const ttl = response.retention === "long" ? ANTHROPIC_LONG_TTL_MS : ANTHROPIC_SHORT_TTL_MS;
      const retentionLabel = response.retention === "long" ? "1-hour" : "5-minute";
      const remainingMs = response.requestedAt + ttl - this.now;
      if (remainingMs <= 0)
        return {
          state: "likely-cold",
          label: "Cache expired",
          detail: `The provider’s ${retentionLabel} prompt-cache window has elapsed.`,
        };
      return {
        state: "likely-warm",
        label: `Cache estimated ${formatRemaining(remainingMs)}`,
        detail: `Likely cached. Anthropic’s ${retentionLabel} cache window refreshes on use.`,
        remainingMs,
      };
    }

    if (model.provider === "openai" || model.provider === "openai-codex") {
      // OpenAI currently has both 30-minute and 24-hour long-retention modes.
      // Model identity alone does not reliably distinguish them.
      if (response.retention === "long") return undefined;
      if (response.inputTokens + response.cacheReadTokens < OPENAI_MIN_CACHEABLE_TOKENS)
        return undefined;
      const elapsedMs = this.now - response.requestedAt;
      if (elapsedMs < OPENAI_LIKELY_WARM_MS) {
        const remainingMs = OPENAI_LIKELY_WARM_MS - elapsedMs;
        return {
          state: "likely-warm",
          label: `Cache estimated ${formatRemaining(remainingMs)}`,
          detail:
            "Likely cached. OpenAI generally retains prompts for at least 5 minutes of inactivity.",
          remainingMs,
        };
      }
      if (elapsedMs < OPENAI_LIKELY_COLD_MS)
        return {
          state: "uncertain",
          label: "Cache uncertain",
          detail: "OpenAI commonly evicts prompts after 5–10 minutes of inactivity.",
        };
      return {
        state: "likely-cold",
        label: "Cache likely expired",
        detail: "More than 10 minutes have passed; OpenAI may retain the prompt longer.",
      };
    }

    return undefined;
  }

  private get shouldTick() {
    return this.prediction?.state === "likely-warm";
  }

  private latestResponse(model: {
    provider: string;
    modelId: string;
  }): PromptCacheResponse | undefined {
    const parts = this.props.parts();
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]!;
      // Compaction replaces the reusable conversation prefix. Wait for the next
      // provider response before starting a fresh cache estimate.
      if (part.kind === "compaction") return undefined;
      if (!("response" in part)) continue;
      const response = part.response;
      if (response?.provider === model.provider && response.modelId === model.modelId)
        return response;
    }
    return undefined;
  }

  private updateTick(active: boolean) {
    if (!active) {
      this.stopTick();
      return;
    }
    if (this.tickInterval !== undefined) return;
    this.now = Date.now();
    this.tickInterval = setInterval(() => {
      this.now = Date.now();
    }, 1_000);
  }

  private stopTick() {
    if (this.tickInterval === undefined) return;
    clearInterval(this.tickInterval);
    this.tickInterval = undefined;
  }
}

function formatRemaining(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
