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
 * 3. Still over budget: throw {@link WidgetBuildSessionOverBudget}. Pruning keeps every
 *    user and assistant message, so a long-lived build session (forked parent history,
 *    restated assignments, briefs and state) can outgrow the model even with no tools;
 *    the caller then starts a replacement session seeded with the current widget.
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
    if (tokensBefore > budget)
      throw new WidgetBuildSessionOverBudget(manager, tokensBefore, budget, options.model);
    return { route: "unchanged", tokens: tokensBefore };
  }
  appendToolPrunedBranch(manager, source, {
    provider: options.model.provider,
    modelId: options.model.id,
    thinkingLevel: manager.buildSessionContext().thinkingLevel,
  });
  const tokens = estimateBuildContextTokens(manager);
  if (tokens > budget)
    throw new WidgetBuildSessionOverBudget(manager, tokens, budget, options.model);
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

/** A reopened build session cannot fit its model even after tool pruning. */
export class WidgetBuildSessionOverBudget extends Error {
  readonly sessionId: string;
  readonly tokens: number;
  readonly budget: number;

  constructor(manager: SessionManager, tokens: number, budget: number, model: Model<Api>) {
    super(
      `Widget build session ${manager.getSessionId()} still needs about ${tokens.toLocaleString("en-US")} tokens after tool pruning, over its ${budget.toLocaleString("en-US")}-token budget for ${model.provider}/${model.id}.`,
    );
    this.name = "WidgetBuildSessionOverBudget";
    this.sessionId = manager.getSessionId();
    this.tokens = tokens;
    this.budget = budget;
  }
}

/** Custom entry that links a replacement build session to the one it replaced. */
export const widgetBuildReplacementEntryType = "cake.widget-build-replacement/v1";

/**
 * Checks that a fresh build session seeded with only the current widget and the
 * revision request fits the model. Nothing is sent or persisted when it does not.
 */
export function assertSeededWidgetBuildFits(
  seed: string,
  options: { readonly model: Model<Api>; readonly reserveTokens: number },
) {
  const budget = options.model.contextWindow - options.reserveTokens;
  const tokens = estimateTokens({ role: "user", content: seed, timestamp: 0 });
  if (tokens > budget) throw seededOverBudget(tokens, budget, options.model);
}

/** The caller-actionable failure when even a seeded replacement session cannot fit. */
export function seededOverBudget(tokens: number | undefined, budget: number, model: Model<Api>) {
  const size =
    tokens === undefined
      ? "more tokens than"
      : `about ${tokens.toLocaleString("en-US")} tokens, over`;
  return new Error(
    `Widget revision did not fit: a fresh build session seeded with only the current widget source, brief, state and this request needs ${size} the ${budget.toLocaleString("en-US")}-token budget of ${model.provider}/${model.id}. Nothing was published and the current revision is unchanged. Shorten the widget source, its state or the request (for example split the widget), or run the revision from a session whose model has a larger context window.`,
  );
}
