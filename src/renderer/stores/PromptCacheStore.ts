import { Store, untracked } from "r-state-tree";
import type { UiPart } from "../../contracts/conversations/session-contract";

import {
  promptCachePrediction,
  type PromptCachePrediction,
} from "../../utils/prompt-cache-prediction";

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
    return model ? promptCachePrediction(this.props.parts(), model, this.now) : undefined;
  }

  private get shouldTick() {
    return this.prediction?.state === "likely-warm";
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
