import { Effect } from "effect";
import { currentSessionOutcome } from "../../contracts/project-sessions/session-reporting";
import { agentListPage } from "../../contracts/agent/agent-list-data";
import type { AgentSessionListInput } from "../../contracts/project-sessions/agent-session-list";
import type { CompletionInboxItem } from "../../contracts/conversations/completion-inbox";
import { sessionLink } from "../../contracts/conversations/message-reference";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import type { AgentControlCaller } from "./agentControl";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";

const groups = [
  "working",
  "waiting-for-input",
  "ready-for-review/merge",
  "blocked/stopped",
  "resolved",
] as const;
const brief = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const meaningful = (title: string | undefined) =>
  title &&
  !/^(?:task session|new (?:project )?session|untitled|session(?: [\da-f-]+)?)$/i.test(title.trim())
    ? brief(title, 96)
    : undefined;
const cell = (value: string) => (/[\t\r\n"\\]/.test(value) ? JSON.stringify(value) : value);

/** Deliberately does not use the Pi catalog/preview APIs: even title discovery there
 * can open JSONL. Only launch/decision/lifecycle metadata and existing runtime facts
 * participate. Reading this projection never acquires a runtime or checks out Git. */
export const launchWorkflowRoster = Effect.fn("AgentControl.launchWorkflowRoster")(function* (
  input: AgentSessionListInput,
  caller: AgentControlCaller,
) {
  const fail = (error: string) => ({ ok: false, command: "sessions.list", error });
  if (caller.kind !== "cake-chat")
    return fail("The workflow roster requires the invoking Cake Chat.");
  const application = (yield* ApplicationState).snapshot();
  const global = caller.sessionId === CAKE_CHAT_SESSION_ID;
  const project = application.projects.find(
    (item) => projectChatSessionId(item.path) === caller.sessionId,
  );
  if (!global && !project) return fail("The caller has no registered project scope.");
  const state = yield* (yield* SessionFamilyStorage).state();
  const launches = state.spawnedSessions.filter(
    (spawn) =>
      spawn.requester.sessionId === caller.sessionId &&
      (global || spawn.projectPath === project?.path) &&
      (!input.projectPath || spawn.projectPath === input.projectPath),
  );
  const latest = new Map<string, CompletionInboxItem>();
  for (const item of state.completionInbox ?? []) {
    if (item.coordinatorSessionId !== caller.sessionId) continue;
    const previous = latest.get(item.sessionId);
    if (
      !previous ||
      item.reportedAt > previous.reportedAt ||
      (item.reportedAt === previous.reportedAt && item.id > previous.id)
    )
      latest.set(item.sessionId, item);
  }
  const configuration = yield* ProjectSessionConfiguration;
  const archive = yield* SessionArchiveStorage;
  const runtimes = yield* CakeSessionRuntimes;
  const worktrees = yield* (yield* ManagedWorktrees).records();
  const waits = yield* (yield* RendererRequestCoordinator).pendingUserInputs();
  const resolvedByDirectory = new Map<string, ReadonlySet<string> | undefined>();
  const rows = yield* Effect.forEach(launches, (spawn) =>
    Effect.gen(function* () {
      const family = state.families.find(
        (item) =>
          item.parentSessionId === spawn.sessionId ||
          item.children.some((child) => child.sessionId === spawn.sessionId),
      );
      const directory = family?.workingDirectory ?? spawn.workingDirectory;
      if (!resolvedByDirectory.has(directory)) {
        resolvedByDirectory.set(
          directory,
          yield* archive
            .recordedResolvedIds({
              cwd: directory,
              activeRoot: configuration.sessionDirectory,
              resolvedRoot: configuration.resolvedSessionDirectory,
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined))),
        );
      }
      const resolvedIds = resolvedByDirectory.get(directory);
      const resolved = resolvedIds?.has(family?.parentSessionId ?? spawn.sessionId);
      const runtime = yield* runtimes.currentStatus({
        sessionId: spawn.sessionId,
        workingDirectory: spawn.workingDirectory,
        sessionDirectory: configuration.sessionDirectory,
      });
      const completion = latest.get(spawn.sessionId);
      const report =
        spawn.lastReport && (!completion || spawn.lastReport.reportedAt >= completion.reportedAt)
          ? spawn.lastReport
          : undefined;
      // Keep the latest result only; old duplicate notices are not additional tasks.
      const currentResult =
        completion && (!report || completion.reportedAt >= report.reportedAt)
          ? completion
          : undefined;
      const worktree = worktrees.find(
        (item) =>
          item.worktreePath === spawn.workingDirectory && item.projectPath === spawn.projectPath,
      );
      const landed = worktree?.state === "landed" || worktree?.resolvedFrom === "landed";
      const todo = application.projects
        .find((item) => item.path === spawn.projectPath)
        ?.todos?.items.find((item) =>
          item.associations.some(
            (link) => link.kind === "session" && link.sessionId === spawn.sessionId,
          ),
        );
      const title =
        meaningful(todo?.title) ??
        meaningful(spawn.title) ??
        meaningful(completion?.title) ??
        (worktree
          ? `Worktree: ${brief(worktree.branch.replace(/^agent\//, ""), 80)}`
          : "Unnamed task (title unknown)");
      const wait = waits.find((item) => item.sessionId === spawn.sessionId);
      const currentOutcome = currentSessionOutcome(runtime?.latestTurnOutcome, report?.status);
      const failed = currentOutcome === "failed";
      const stopped = currentOutcome === "stopped" || currentOutcome === "interrupted";
      const blocked =
        runtime?.recoveryIssue || currentOutcome === "blocked" || currentResult?.kind === "blocked";
      const busy = runtime?.streaming || runtime?.pending;
      const ready = currentResult?.kind === "ready" && !failed && !stopped && !blocked;
      const group: (typeof groups)[number] = resolved
        ? "resolved"
        : wait
          ? "waiting-for-input"
          : busy
            ? "working"
            : blocked || failed || stopped
              ? "blocked/stopped"
              : ready
                ? "ready-for-review/merge"
                : "working";
      const execution = wait
        ? "waiting"
        : runtime?.streaming
          ? "running"
          : runtime?.pending
            ? "queued"
            : blocked
              ? "blocked"
              : failed
                ? "failed"
                : stopped
                  ? "stopped"
                  : (currentOutcome ??
                    (currentResult
                      ? "completed"
                      : runtime?.latestTurnOutcome === "complete"
                        ? "complete"
                        : "unknown"));
      const reason =
        wait?.reason ??
        runtime?.recoveryIssue ??
        (blocked || failed || stopped ? (currentResult?.summary ?? report?.summary) : undefined);
      const outcome = currentResult?.summary ?? report?.summary;
      const worktreeFact = !worktree
        ? spawn.workingDirectory === spawn.projectPath
          ? "none"
          : "unknown"
        : `${worktree.branch}:${worktree.state ?? "active"}${worktree.pendingStrategy ? `; pending-landing=${worktree.pendingStrategy}` : ""}${worktree.landedSourceCommit ? `; landed-source=${worktree.landedSourceCommit}` : ""}; head/dirty=unknown`;
      const next = resolved
        ? "none"
        : wait
          ? "answer input"
          : busy
            ? "wait"
            : blocked || failed || stopped
              ? "inspect blocker/stop"
              : worktree?.pendingStrategy
                ? "inspect pending landing"
                : landed
                  ? "review/resolve; already landed"
                  : ready
                    ? "review result; verify merge"
                    : "inspect; readiness unknown";
      return {
        sessionId: spawn.sessionId,
        title,
        group,
        execution,
        lifecycle: resolved === undefined ? "unknown" : resolved ? "resolved" : "open",
        reason: reason ? brief(reason) : "-",
        result: completion?.resultMessageRef ?? "-",
        outcome: outcome ? brief(outcome) : "unknown",
        decision: completion?.state ?? "unknown",
        worktree: worktreeFact,
        merge: landed ? "already-landed" : "unknown",
        next,
        date:
          [report?.reportedAt ?? "", completion?.reportedAt ?? "", spawn.launchedAt ?? ""]
            .sort()
            .at(-1) ?? "",
      };
    }),
  );
  const selected = rows
    .filter(
      (row) =>
        (input.includeResolved || input.status === "resolved" || row.lifecycle !== "resolved") &&
        (!input.query ||
          `${row.title} ${row.sessionId}`.toLowerCase().includes(input.query.toLowerCase())) &&
        (!input.status ||
          (input.status === "resolved"
            ? row.lifecycle === "resolved"
            : input.status === "done"
              ? ["completed", "complete"].includes(row.execution)
              : input.status === "needs-you"
                ? ["waiting-for-input", "blocked/stopped"].includes(row.group)
                : row.execution === input.status)) &&
        (!input.attentionOnly ||
          ["waiting-for-input", "ready-for-review/merge", "blocked/stopped"].includes(row.group)),
    )
    .sort(
      (a, b) =>
        groups.indexOf(a.group) - groups.indexOf(b.group) ||
        b.date.localeCompare(a.date) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  const page = agentListPage(selected, input);
  const counts = groups
    .map((group) => `${group}=${selected.filter((row) => row.group === group).length}`)
    .join(" ");
  const lines = [
    `${page.total} launches${page.nextOffset === null ? "" : `; next=${page.nextOffset}`} | ${counts}`,
    "Recorded metadata only; working includes idle/unknown. Merge=unknown is unverified. Result=latest retained link; decision is not resolution/unreadness.",
  ];
  if (page.items.length)
    lines.push(
      "group\ttask\tsession\tlifecycle\texecution\treason\tresult\toutcome\tdecision\tworktree\tmerge\tnext",
    );
  for (const row of page.items)
    lines.push(
      [
        row.group,
        row.title,
        sessionLink(row.sessionId),
        row.lifecycle,
        row.execution,
        row.reason,
        row.result,
        row.outcome,
        row.decision,
        row.worktree,
        row.merge,
        row.next,
      ]
        .map(cell)
        .join("\t"),
    );
  return lines.join("\n");
});
