import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import type { JsonValue } from "../../../ipc/json-contract";
import { SESSION_TITLE_MAX_LENGTH, type UtilityModel } from "../../../ipc/session-contract";
import type { CakeRuntimeOptions } from "./cake-runtime";
import { appendToolCompactedBranch } from "./session-tool-compaction";
import { textFromContent } from "./session-projection";

interface PendingSessionFork {
  readonly entryId?: string;
  readonly prompt?: string;
  readonly title?: string;
  readonly resolveSource: boolean;
  readonly placement: "none" | "right" | "down";
  readonly destinationWorkingDirectory?: string;
}

export interface CakeRuntimeContinuations {
  activeSessionTitle(): string;
  nameSessionFromFirstMessage(currentUserMessage: string): Promise<void>;
  rename(name: string, reportAction?: boolean): Promise<string>;
  fork(entryId: string, title: string): Promise<{ sessionId: string; sessionFile: string }>;
  toolCompact(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  scheduleFork(input: PendingSessionFork): JsonValue;
  setResolved(resolved: boolean): Promise<JsonValue>;
  finishSettledTurn(): Promise<void>;
  dispose(): void;
}

export function createCakeRuntimeContinuations(input: {
  options: CakeRuntimeOptions;
  session: AgentSession;
  sessionId: string;
  isDisposed(): boolean;
  emitSnapshot(): Promise<void>;
  emitNotice(part: {
    id: string;
    kind: "notice";
    tone: "error";
    title: string;
    detail: string;
  }): void;
  drainReloads(): Promise<void> | undefined;
  handleSettledTurn(): Promise<void>;
  reportAgentAction(action: "rename" | "resolve" | "restore", detail?: string): Promise<void>;
}): CakeRuntimeContinuations {
  const {
    options,
    session,
    sessionId,
    isDisposed,
    emitSnapshot,
    emitNotice,
    drainReloads,
    handleSettledTurn,
    reportAgentAction,
  } = input;
  let sessionNamingInFlight = false;
  const sessionNamingController = new AbortController();
  let forkOnSettle: PendingSessionFork | undefined;
  let resolveOnSettle = false;

  const activeSessionTitle = () => {
    const firstUserMessage = session.sessionManager
      .getEntries()
      .flatMap((entry) => {
        if (
          entry.type !== "message" ||
          entry.message.role !== "user" ||
          !("content" in entry.message)
        )
          return [];
        return [textFromContent(entry.message.content).trim()];
      })
      .find(Boolean);
    return (session.sessionManager.getSessionName() || firstUserMessage || "New chat").slice(
      0,
      SESSION_TITLE_MAX_LENGTH,
    );
  };

  const rename = async (name: string, shouldReport = false) => {
    const normalizedName = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    session.setSessionName(normalizedName);
    await emitSnapshot();
    const committedTitle = session.sessionManager.getSessionName() ?? name.trim();
    if (shouldReport) await reportAgentAction("rename", committedTitle);
    return committedTitle;
  };

  return {
    activeSessionTitle,
    async nameSessionFromFirstMessage(currentUserMessage) {
      if (isDisposed() || sessionNamingInFlight || session.sessionManager.getSessionName()) return;
      const firstUserMessage = session.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
        .filter((message) => message.role === "user")
        .map((message) => textFromContent(message.content).trim())
        .find(Boolean);
      const userText = firstUserMessage || currentUserMessage.trim();
      if (!userText) return;
      const utilityModel: UtilityModel | undefined = options.utilityModel?.();
      const generateTitle = options.generateSessionTitle;
      if (!utilityModel || !generateTitle) return;

      sessionNamingInFlight = true;
      try {
        const title = await generateTitle({
          utilityModel,
          firstUserMessage: userText,
          signal: AbortSignal.any([sessionNamingController.signal, AbortSignal.timeout(15_000)]),
        });
        if (isDisposed() || !title || session.sessionManager.getSessionName()) return;
        const normalizedTitle = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
        session.setSessionName(normalizedTitle);
        await emitSnapshot();
      } catch {
        // Utility work is opportunistic. The first-message title remains the fallback.
      } finally {
        sessionNamingInFlight = false;
      }
    },
    rename,
    async fork(entryId, title) {
      const sourceSessionFile = session.sessionFile;
      if (!sourceSessionFile || !existsSync(sourceSessionFile))
        throw new Error(
          "This session has not been saved yet. Wait for the first assistant response before forking it.",
        );
      // Branch a separate SessionManager opened on the source file, as Pi's own
      // AgentSessionRuntime.fork() does. Branching the live session manager in
      // place would repoint this still-running source runtime at the fork's
      // file while its Agent keeps the source session ID (and prompt cache key).
      const forked = SessionManager.open(
        sourceSessionFile,
        session.sessionManager.getSessionDir(),
        options.cwd,
      );
      const sessionFile = forked.createBranchedSession(entryId);
      if (!sessionFile) throw new Error("The current session is not persisted");
      forked.appendSessionInfo(title);
      return { sessionId: forked.getSessionId(), sessionFile };
    },
    async toolCompact(entryId) {
      const configuration = session.model
        ? {
            provider: session.model.provider,
            modelId: session.model.id,
            thinkingLevel: session.thinkingLevel,
          }
        : undefined;
      const previousLeafId = session.sessionManager.getLeafId();
      const result = appendToolCompactedBranch(session.sessionManager, entryId, configuration);
      if (!result.sessionFile) throw new Error("The current session is not persisted");
      if (previousLeafId) session.sessionManager.branch(previousLeafId);
      else session.sessionManager.resetLeaf();
      const navigation = await session.navigateTree(result.leafId, { summarize: false });
      if (navigation.cancelled) throw new Error("Tool compaction navigation was cancelled");
      await emitSnapshot();
      return { sessionId: result.sessionId, sessionFile: result.sessionFile };
    },
    scheduleFork(pending) {
      if (!options.currentSessionControl?.forkSession)
        throw new Error("This Project Session cannot be forked by its agent");
      forkOnSettle = pending;
      return { sessionId, forkOnSettle: true, resolveSource: pending.resolveSource };
    },
    async setResolved(resolved) {
      if (!options.currentSessionControl)
        throw new Error("This Cake runtime cannot change session resolution");
      if (
        resolved &&
        session.isStreaming &&
        options.currentSessionControl.deferResolution !== false
      ) {
        resolveOnSettle = true;
        return {
          sessionId,
          resolved: options.currentSessionControl.resolved(),
          resolveOnSettle: true,
        };
      }
      resolveOnSettle = false;
      await options.currentSessionControl.setResolved(resolved);
      await reportAgentAction(resolved ? "resolve" : "restore");
      return { sessionId, resolved, resolveOnSettle: false };
    },
    async finishSettledTurn() {
      if (forkOnSettle) {
        await emitSnapshot().catch(() => undefined);
        if (isDisposed() || session.isStreaming) return;
        const pending = forkOnSettle;
        forkOnSettle = undefined;
        const entryId = pending.entryId ?? session.sessionManager.getLeafId();
        try {
          if (!entryId) throw new Error("The current session does not contain a message to fork");
          await options.currentSessionControl?.forkSession?.({ ...pending, entryId });
        } catch (error) {
          if (isDisposed()) return;
          emitNotice({
            id: "session-fork-failed",
            kind: "notice",
            tone: "error",
            title: "Could not fork session",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (resolveOnSettle) {
        await emitSnapshot().catch(() => undefined);
        if (isDisposed()) return;
        if (session.isStreaming) return;
        resolveOnSettle = false;
        try {
          await options.currentSessionControl?.setResolved(true);
          await reportAgentAction("resolve");
        } catch (error) {
          if (isDisposed()) return;
          emitNotice({
            id: "session-resolution-failed",
            kind: "notice",
            tone: "error",
            title: "Could not resolve session",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      await drainReloads()?.catch(() => undefined);
      await emitSnapshot().catch(() => undefined);
      await handleSettledTurn();
    },
    dispose() {
      sessionNamingController.abort();
    },
  };
}
