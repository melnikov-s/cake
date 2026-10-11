import {
  SessionManager,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  WidgetConversationOrigin,
  WidgetConversationTarget,
} from "../../../contracts/widgets/widget-conversation";
import { assertSessionPath } from "./session-path";
import { findSessionFileById } from "../../storage/session-files";

/** Captured before asynchronous generation: later parent messages cannot move the branch point. */
export function captureWidgetConversation(runtime: {
  readonly sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getSessionFile" | "getLeafId"
  >;
}): WidgetConversationOrigin {
  const manager = runtime.sessionManager;
  const sessionFile = manager.getSessionFile();
  const entryId = manager.getLeafId();
  if (!sessionFile || !entryId)
    throw new Error("Widget generation requires a persisted parent conversation");
  return { sessionId: manager.getSessionId(), sessionFile, entryId };
}

/**
 * A tool invokes generation while its own assistant/tool-result batch is incomplete.
 * Cut before the earliest unresolved batch, using Pi's edited, compacted projection.
 * The explicit generation prompt replaces the omitted in-flight assignment.
 */
function completePrefix(manager: SessionManager): string {
  const pending = new Map<string, SessionEntry>();
  for (const projected of manager.buildSessionProjection().entries) {
    for (const message of projected.messages) {
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall") pending.set(block.id, projected.sourceEntry);
        }
      } else if (message.role === "toolResult") {
        pending.delete(message.toolCallId);
      }
    }
  }
  const earliest = pending.values().next().value;
  const leaf = earliest ? earliest.parentId : manager.getLeafId();
  if (!leaf) throw new Error("Widget generation has no complete ancestor context");
  return leaf;
}

/** Forks a separate manager; never branches or writes the live caller's manager. */
export async function prepareWidgetConversation(options: {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionRoots: ReadonlyArray<string>;
  readonly conversation: WidgetConversationTarget;
}): Promise<SessionManager> {
  const target = options.conversation;
  const sessionFile =
    target.type === "parent"
      ? target.origin.sessionFile
      : await findSessionFileById(target.sessionId, {
          workingDirectory: options.cwd,
          root: options.sessionDir,
          direct: true,
        });
  if (!sessionFile) throw new Error("The widget generation conversation is no longer available");
  if (
    !options.sessionRoots.some((root) => {
      try {
        assertSessionPath(sessionFile, root, "Widget conversation");
        return true;
      } catch {
        return false;
      }
    })
  )
    throw new Error("Widget conversation is outside the allowed session roots");
  const manager = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
  const expectedId = target.type === "parent" ? target.origin.sessionId : target.sessionId;
  if (manager.getSessionId() !== expectedId)
    throw new Error("Widget conversation identity does not match its source");
  if (target.type === "continue") return manager;
  if (target.type === "parent") {
    if (!manager.getEntry(target.origin.entryId))
      throw new Error("The widget conversation branch point is no longer available");
    manager.branch(target.origin.entryId);
  }
  const sourceSessionId = manager.getSessionId();
  const requestedEntryId = manager.getLeafId();
  const entryId = completePrefix(manager);
  if (!manager.createBranchedSession(entryId))
    throw new Error("The widget conversation branch could not be persisted");
  manager.appendCustomEntry("cake.widget-conversation/v1", {
    sourceSessionId,
    requestedEntryId,
    entryId,
  });
  return manager;
}
