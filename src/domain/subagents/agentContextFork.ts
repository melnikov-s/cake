import { Effect } from "effect";
import type { AgentContextFork } from "../../contracts/cake-chats/agent-context-fork";
import {
  isCakeChatSessionId,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { subagentLink } from "../../contracts/subagents/subagent-reference";
import { messageReference } from "../../contracts/conversations/message-reference";
import { SubagentError } from "../../contracts/subagents/subagent-data";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import { asSubagentError } from "./subagent-error-message";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import { prepareTasks, type SubagentParentRuntime } from "./subagentTaskPreparation";
import { startPrepared } from "./subagentExecution";

/** Agent tools never enter the human Discussion/Side Chat creation path. */
export const fork = Effect.fn("Subagents.forkContext")(function* (
  input: AgentContextFork,
  parent: SubagentParentRuntime,
  projectPath?: string,
  anchorPartId?: string,
) {
  const application = yield* ApplicationState;
  if (
    parent.options.profile._tag !== "CakeChatSession" ||
    !isCakeChatSessionId(parent.parentSessionId) ||
    cakeChatSideChatParentId(parent.parentSessionId) !== undefined ||
    (projectPath !== undefined && projectPath !== input.workspacePath) ||
    !application.snapshot().projects.some((project) => project.path === input.workspacePath) ||
    !(yield* (yield* ProjectAccess).isAllowed(input.workspacePath))
  )
    return yield* new SubagentError({
      operation: "fork",
      message: "The Project is not authorized for this permanent chat",
    });
  const seedContext = (yield* SubagentEnvironment).seedContext;
  if (!seedContext)
    return yield* new SubagentError({
      operation: "fork",
      message: "Agent-owned context forks are unavailable in this runtime",
    });
  const context = yield* (yield* CakeChatDurable).taskContext(
    parent.parentSessionId,
    input.entryId,
  );
  const resultDelivery = input.resultDelivery ?? "notification";
  const [prepared] = yield* prepareTasks(
    [
      {
        task: input.initialPrompt,
        projectPath: input.workspacePath,
        model: { prefer: "current" },
        fastMode: parent.options.runtime.fastMode?.get() ?? false,
        continuation: resultDelivery === "reply" ? "resume" : "none",
        allowMutations: false,
        instructions: `Context-forked subagent: ${input.name}. Inherited history is settled context only, not current authority. Read applicable project instructions in this managed checkout. Investigate read-only; if code changes are needed, return findings for a fresh sessions.create handoff. Never create a human Side Chat. Completion is delivered automatically; do not duplicate the report.`,
        ...(input.inputRefs ? { inputRefs: input.inputRefs } : null),
        ...(input.messageRefs ? { messageRefs: input.messageRefs } : null),
      },
    ],
    parent,
  );
  if (!prepared)
    return yield* new SubagentError({ operation: "fork", message: "Task preflight failed" });
  const worktree = yield* managedWorktrees.create({
    projectPath: input.workspacePath,
    worktreeName: input.worktreeName,
    backgroundSetup: true,
  });
  yield* (yield* ManagedWorktrees).awaitSetup(worktree.worktreePath);
  const inputs = yield* TaskInputStorage;
  const initializeContext = Effect.fn("Subagents.initializeForkContext")(function* (
    recipientSessionId: string,
  ) {
    yield* seedContext(worktree.worktreePath, recipientSessionId, context).pipe(
      asSubagentError("fork"),
    );
    yield* inheritTaskInputProtection(parent.parentSessionId, recipientSessionId).pipe(
      Effect.provideService(TaskInputStorage, inputs),
      asSubagentError("fork"),
    );
  });
  const started = yield* startPrepared(
    { ...prepared, workingDirectory: worktree.worktreePath, initializeContext },
    anchorPartId ?? `subagent-${crypto.randomUUID()}`,
    resultDelivery !== "ignore",
  );
  return {
    ok: true,
    command: "sessions.fork",
    ...started.receipt,
    status: "started",
    sourceSessionId: parent.parentSessionId,
    entryId: context.entryId,
    sourceMessageRef: messageReference(parent.parentSessionId, context.entryId),
    ref: subagentLink(parent.parentSessionId, started.handleId),
    workspacePath: worktree.worktreePath,
    managedWorktree: worktree,
    resultDelivery,
  };
});
