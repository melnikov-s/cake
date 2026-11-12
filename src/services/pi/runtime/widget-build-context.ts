import {
  calculateContextTokens,
  estimateTokens,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow, type Api, type Model } from "@earendil-works/pi-ai";
import { promptCachePrediction } from "../../../utils/prompt-cache-prediction";
import { projectSessionEntries } from "./session-projection";
import { appendToolPrunedBranch } from "./session-tool-prune";

/**
 * A cold build session below this size keeps its tool history: re-sending it costs
 * little, and the tool results are useful build context.
 */
const COLD_PRUNE_FLOOR_TOKENS = 50_000;

/** How a revision fitted its build session before sending the request. */
export type WidgetBuildContextFit =
  /** Cache likely warm: the session compacts itself through Pi's auto-compaction. */
  | { readonly route: "warm"; readonly tokens: number }
  /** Cache cold (or compaction failed): tool calls/results were pruned in place. */
  | { readonly route: "pruned"; readonly tokensBefore: number; readonly tokens: number }
  /** Cold but small, or nothing to prune; already within budget. */
  | { readonly route: "unchanged"; readonly tokens: number };

/** Pi's context estimate: the latest provider usage plus messages appended after it. */
function estimateBuildContextTokens(manager: SessionManager) {
  const messages = manager.buildSessionContext().messages;
  let trailing = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "assistant" &&
      message.stopReason !== "error" &&
      message.stopReason !== "aborted"
    ) {
      const used = calculateContextTokens(message.usage);
      if (used > 0) return used + trailing;
    }
    trailing += estimateTokens(message);
  }
  return trailing;
}

/** The latest assistant reply on the branch that tool pruning can use as its source. */
function latestTextReply(manager: SessionManager) {
  return manager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some((block) => block.type === "text" && block.text.trim()),
    )?.id;
}

/**
 * Fits a reopened widget build session to the model before a revision request.
 *
 * 1. Warm prompt cache: keep everything. Pi's auto-compaction (always on for build
 *    sessions) compacts before the request when it would cross the threshold.
 * 2. Cold cache, or `force` after compaction failed: run the deterministic tool prune
 *    on this same session (dialogue kept, no model call).
 * 3. Still over budget: fail clearly. Cake never substitutes a fresh session.
 */
export function fitWidgetBuildSession(
  manager: SessionManager,
  options: {
    readonly model: Model<Api>;
    readonly reserveTokens: number;
    readonly now: number;
    /** Prune even with a warm cache: auto-compaction could not fit the session. */
    readonly force?: boolean;
  },
): WidgetBuildContextFit {
  const budget = options.model.contextWindow - options.reserveTokens;
  const tokensBefore = estimateBuildContextTokens(manager);
  const cache = promptCachePrediction(
    projectSessionEntries(manager.getBranch()),
    { provider: options.model.provider, modelId: options.model.id },
    options.now,
  );
  if (!options.force && cache?.state === "likely-warm")
    return { route: "warm", tokens: tokensBefore };
  const source = latestTextReply(manager);
  if (!source || (!options.force && tokensBefore <= COLD_PRUNE_FLOOR_TOKENS)) {
    if (tokensBefore > budget) throw overBudget(manager, tokensBefore, budget, options.model);
    return { route: "unchanged", tokens: tokensBefore };
  }
  appendToolPrunedBranch(manager, source, {
    provider: options.model.provider,
    modelId: options.model.id,
    thinkingLevel: manager.buildSessionContext().thinkingLevel,
  });
  const tokens = estimateBuildContextTokens(manager);
  if (tokens > budget) throw overBudget(manager, tokens, budget, options.model);
  return { route: "pruned", tokensBefore, tokens };
}

/** Whether a finished turn stopped because the request exceeded the model's context. */
export function endedInContextOverflow(manager: SessionManager) {
  const reply = manager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  return (
    reply?.type === "message" &&
    reply.message.role === "assistant" &&
    isContextOverflow(reply.message)
  );
}

function overBudget(manager: SessionManager, tokens: number, budget: number, model: Model<Api>) {
  return new Error(
    `Widget build session ${manager.getSessionId()} still needs about ${tokens.toLocaleString("en-US")} tokens after tool pruning, over its ${budget.toLocaleString("en-US")}-token budget for ${model.provider}/${model.id}. Cake did not start a replacement build session; retry with a larger-context model.`,
  );
}
