import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import type { RuntimeOperationApi } from "../../../contracts/agent/cake-operation-api";
import { promptFilesSchema } from "../../../contracts/conversations/prompt-files";
import { crossSessionContextSnapshot } from "../../../contracts/conversations/cross-session-message";
import { jsonValueSchema, type JsonObject } from "../../../contracts/serialization/json-contract";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../../contracts/conversations/response-mode-reminders";
import type { CakeSessionRuntimeOptions } from "./cake-session-runtime";
import type { CakeSessionRuntimeConfiguration } from "./cake-session-runtime-configuration";
import type { CakeSessionRuntimeContinuations } from "./cake-session-runtime-continuations";
import type { CakeSessionRuntimeCapabilities } from "./cake-session-runtime-capabilities";
import type { CakeSessionRuntimeTurnController } from "./cake-session-runtime-turn-controller";
import { textFromContent } from "./tool-projection";

/** The current-session Cake controls apply policy hooks to the same live Pi session. */
export function createCakeSessionRuntimeOperationApi(input: {
  options: CakeSessionRuntimeOptions;
  session: AgentSession;
  configuration: CakeSessionRuntimeConfiguration;
  continuations: CakeSessionRuntimeContinuations;
  capabilities: CakeSessionRuntimeCapabilities;
  turnController: CakeSessionRuntimeTurnController;
}): RuntimeOperationApi {
  const { options, session, configuration, continuations, capabilities, turnController } = input;
  const cakeSessionId = session.sessionManager.getSessionId();
  const resolveTarget = (reference: string, signal: AbortSignal) => {
    if (options.sessionReferences) return options.sessionReferences.resolve(reference, signal);
    if (/^s:/i.test(reference))
      return Promise.reject(
        new Error("Session reference resolution is unavailable in this runtime"),
      );
    return Promise.resolve(reference);
  };
  const currentContextSnapshot = () =>
    crossSessionContextSnapshot(session.getSessionStats().contextUsage);

  return {
    resolveModelSelection: configuration.resolveModelSelection,
    async info() {
      const firstUserMessage = session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? [
                stripResponseModeReminder(
                  stripPresentationModeReminder(textFromContent(entry.message.content)),
                ).trim(),
              ]
            : [],
        )
        .find(Boolean);
      const info: JsonObject = {
        sessionId: cakeSessionId,
        title: continuations.activeSessionTitle(),
        sessionFile: session.sessionFile ?? "",
        ...(firstUserMessage ? { firstUserMessage } : null),
        workspacePath: options.cwd,
        resolved: options.currentSessionControl?.resolved() ?? false,
        model: {
          provider: session.model?.provider ?? "unknown",
          id: session.model?.id ?? "unknown",
          reasoning: session.thinkingLevel,
        },
      };
      const family = (await options.currentSessionControl?.readPolicy())?.family;
      return Schema.decodeUnknownSync(jsonValueSchema)(
        family === undefined ? info : { ...info, family },
      );
    },
    usage() {
      const stats = session.getSessionStats();
      return Schema.decodeUnknownSync(jsonValueSchema)({
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        reportedCostUsd: stats.cost,
        pricingCoverage: options.partialPricingCoverage
          ? "partial"
          : session.model
            ? "complete"
            : "unknown",
      });
    },
    contextStatus() {
      const { usedTokens: tokens, windowTokens: limit } = currentContextSnapshot();
      return Schema.decodeUnknownSync(jsonValueSchema)({
        tokens,
        limit,
        remaining: tokens === null || limit === null ? null : Math.max(0, limit - tokens),
        utilization: tokens === null || limit === null ? null : tokens / limit,
        measurement: "estimated",
      });
    },
    async compact(instructions) {
      await turnController.compact(instructions);
      await capabilities.reportAgentAction("compact");
      return { status: "compacted" };
    },
    async rename(title) {
      const committedTitle = await continuations.rename(title, true);
      return { sessionId: cakeSessionId, title: committedTitle };
    },
    async createSession(input, signal) {
      if (!options.currentSessionControl?.createSession)
        throw new Error("This Cake runtime cannot create project sessions");
      return options.currentSessionControl.createSession(
        { ...input, model: configuration.resolveModelSelection(input.model) },
        signal,
      );
    },
    async createDraftSession(input, signal) {
      if (!options.currentSessionControl?.createDraftSession)
        throw new Error("This Cake runtime cannot create project draft sessions");
      return options.currentSessionControl.createDraftSession(
        { ...input, model: configuration.resolveModelSelection(input.model) },
        signal,
      );
    },
    async createChildSession(input, requestId, signal) {
      if (!options.currentSessionControl?.createChildSession)
        throw new Error("This Project Session cannot create child sessions");
      return options.currentSessionControl.createChildSession(
        {
          requestId: input.requestId ?? requestId,
          title: input.title,
          assignment: input.assignment,
          resultDelivery: input.resultDelivery,
          open: input.open,
          model: configuration.resolveModelSelection(input.model),
          ...(input.worktreeName === undefined ? null : { worktreeName: input.worktreeName }),
          senderContext: currentContextSnapshot(),
        },
        signal,
      );
    },
    async forkSession(input) {
      return continuations.scheduleFork(input);
    },
    async pendingMessages(sessionId, signal) {
      const pending = options.currentSessionControl?.pendingMessages;
      if (!pending) throw new Error("Project Session queues are unavailable in this runtime");
      return pending(await resolveTarget(sessionId, signal), signal);
    },
    async reorderPendingMessage(sessionId, input, signal) {
      const reorder = options.currentSessionControl?.reorderPendingMessage;
      if (!reorder) throw new Error("Project Session queues are unavailable in this runtime");
      return reorder(await resolveTarget(sessionId, signal), input, signal);
    },
    async mergeSession(targetSessionId, signal) {
      const merge = options.currentSessionControl?.mergeSession;
      if (!merge) throw new Error("Managed Worktree merge is unavailable in this runtime");
      return merge(
        targetSessionId === undefined ? undefined : await resolveTarget(targetSessionId, signal),
        signal,
      );
    },
    async discardSession(targetSessionId, keepBranch, signal) {
      const discard = options.currentSessionControl?.discardSession;
      if (!discard) throw new Error("Managed Worktree discard is unavailable in this runtime");
      return discard(
        targetSessionId === undefined ? undefined : await resolveTarget(targetSessionId, signal),
        keepBranch,
        signal,
      );
    },
    async invokeAppControl(command, input, signal) {
      if (
        (command === "sessions.send" || command === "sessions.reply") &&
        input.promptFiles !== undefined
      ) {
        const { promptFiles, ...rest } = input;
        const paths = Schema.decodeUnknownSync(promptFilesSchema)(promptFiles);
        const capture = options.currentSessionControl?.snapshotPromptFiles;
        if (!capture) throw new Error("Prompt files are unavailable in this runtime");
        const text = await capture(
          Schema.decodeUnknownSync(Schema.String)(input.text),
          paths,
          signal,
        );
        input = { ...rest, text };
      }
      if (typeof input.sessionId === "string")
        input = { ...input, sessionId: await resolveTarget(input.sessionId, signal) };
      const familyResult =
        command === "sessions.send" || command === "sessions.reply"
          ? await options.currentSessionControl?.routeFamilyMessage?.(
              command,
              input,
              signal,
              currentContextSnapshot(),
            )
          : undefined;
      let result = familyResult;
      if (result === undefined) {
        const invoke = options.currentSessionControl?.invokeAppControl;
        if (!invoke) throw new Error("Cross-session Cake controls are unavailable in this runtime");
        result = await invoke(command, input, signal);
      }
      return capabilities.recordAppControlResult(result, session);
    },
    setResolved: continuations.setResolved,
    setModel: configuration.setOperationModel,
  };
}
