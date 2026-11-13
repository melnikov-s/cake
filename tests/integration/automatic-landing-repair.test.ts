import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import { expect, it } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../src/contracts/application/application-data";
import { projectChatSessionId } from "../../src/domain/cake-chats/cakeChatLocations";
import { makeTurnLifecycle } from "../../src/domain/project-sessions/projectSessionTurnLifecycle";
import { runPass } from "../../src/domain/worktrees/autoMerge";
import { report, setEnabled } from "../../src/domain/worktrees/autoMergeReadiness";
import { cancel } from "../../src/domain/worktrees/worktreeLandings";
import { ClientEvents } from "../../src/services/clients/ClientEvents";
import { CakeSessionRuntimes } from "../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../src/services/project-sessions/ProjectSessionConfiguration";
import { RendererRequestCoordinator } from "../../src/services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../src/services/session-catalogs/SessionCatalogChanges";
import { SessionCoordination } from "../../src/services/session-catalogs/SessionCoordination";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../src/services/storage/SessionFamilyStorage";
import {
  WorktreeLandingAgent,
  WorktreeLandingAgentError,
} from "../../src/services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../src/services/worktrees/WorktreeLandingCompletion";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../src/services/worktrees/WorktreeLandingCoordinator";
import { familyStorageHarness } from "../app/helpers/familyStorageHarness";
import { makeTestWorktreeService } from "../helpers/worktree-service";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";

const exec = promisify(execFile);

it.each([
  { scenario: "conflict", ending: "complete" },
  { scenario: "clean-rebase", ending: "complete" },
  { scenario: "clean-rebase", ending: "revoked" },
  { scenario: "clean-rebase", ending: "aborted" },
  { scenario: "clean-rebase", ending: "canceled" },
] as const)(
  "revalidates a real Git $scenario with $ending completion and fresh authorization",
  { timeout: 30_000 },
  async ({ scenario, ending }) => {
    const root = await mkdtemp(join(tmpdir(), "cake-auto-repair-"));
    const engine = makeTestWorktreeService(join(root, ".git", "cake-test-worktrees.json"));
    const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
    const events: string[] = [];
    let executingTurn = "task-turn";
    let validated = "";
    const head = async (cwd: string) => (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.email", "cake@example.test");
      await git(root, "config", "user.name", "Cake Test");
      await writeFile(join(root, "feature.mjs"), "export const feature = 'base';\n");
      await git(root, "add", "feature.mjs");
      await git(root, "commit", "-m", "base");
      const source = await engine.create(root);
      await writeFile(
        join(source.worktreePath, "feature.mjs"),
        "export const feature = 'feature';\n",
      );
      await writeFile(
        join(source.worktreePath, "feature.test.mjs"),
        "import { strict as assert } from 'node:assert';\nimport { feature } from './feature.mjs';\nassert.match(feature, /feature/);\n",
      );
      await git(source.worktreePath, "add", "-A");
      await git(source.worktreePath, "commit", "-m", "feature with scoped acceptance check");
      const original = await head(source.worktreePath);
      await exec(process.execPath, ["--test", "feature.test.mjs"], { cwd: source.worktreePath });
      const upstreamModule = scenario === "conflict" ? "feature.mjs" : "upstream.mjs";
      await writeFile(join(root, upstreamModule), "export const feature = 'upstream';\n");
      await writeFile(
        join(root, "upstream.test.mjs"),
        `import { strict as assert } from 'node:assert';\nimport { feature } from './${upstreamModule}';\nassert.match(feature, /upstream/);\n`,
      );
      await git(root, "add", upstreamModule, "upstream.test.mjs");
      await git(root, "commit", "-m", "upstream requirement");
      const targetBeforeRepair = await head(root);
      const target = {
        sessionId: "owner",
        workingDirectory: source.worktreePath,
        sessionDirectory: "/sessions",
      };
      const ready = (commit: string) => ({
        readyToMerge: true,
        taskCompleted: true,
        validationPassed: true,
        validatedCommit: commit,
      });
      const defaults = defaultApplicationState();
      const application = {
        ...defaults,
        projects: [
          {
            path: root,
            name: "Fixture",
            addedAt: source.createdAt,
            lastOpenedAt: source.createdAt,
            settings: defaultProjectSettings(),
          },
        ],
      };
      const dependencies = Layer.mergeAll(
        familyStorageHarness().layer,
        WorktreeLandingCoordinatorLive,
        Layer.mock(ApplicationState, {
          snapshot: () => application,
          transact: (change) => change(application),
        }),
        Layer.mock(CakeSessionRuntimes, {
          executingTurnIds: () => Effect.sync(() => [executingTurn]),
          activeWorkingDirectories: () => Effect.succeed([]),
        }),
        Layer.mock(ClientEvents, {
          broadcast: () => {
            throw new Error("Automatic landing must not broadcast");
          },
          sendTo: () => {
            events.push("landed-notice");
            return true;
          },
        }),
        Layer.mock(RendererRequestCoordinator, { connectionForSession: () => Effect.succeed(42) }),
        Layer.succeed(ProjectSessionConfiguration, {
          agentDirectory: "/cake",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved",
        }),
        Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active") }),
        Layer.mock(SessionCoordination, { settleTurn: () => Effect.void }),
        Layer.mock(SessionCatalogChanges, { publish: () => Effect.void }),
        Layer.mock(WorktreeLandingCompletion, {
          resolveWorkingDirectory: () =>
            Effect.sync(() => {
              events.push("resolve");
              return {
                projectPath: root,
                workingDirectory: source.worktreePath,
                resolvedSessionIds: ["owner"],
                failures: [],
                cleanupFailures: [],
              };
            }),
        }),
      );
      await engine.run(
        Effect.gen(function* () {
          const families = yield* SessionFamilyStorage;
          yield* families.setPurpose({
            sessionId: "owner",
            projectPath: root,
            purpose: "delegated",
          });
          yield* families.registerSpawn({
            sessionId: "owner",
            projectPath: root,
            workingDirectory: source.worktreePath,
            requester: {
              sessionId: projectChatSessionId(root),
              kind: "cake-chat",
              title: "Project Chat",
            },
            reportDelivered: true,
            handoffSettled: true,
          });
          const coordinator = yield* WorktreeLandingCoordinator;
          const context =
            yield* Effect.context<
              Effect.Services<ReturnType<typeof report> | ReturnType<typeof makeTurnLifecycle>>
            >();
          const agent = WorktreeLandingAgent.of({
            promptContext: () => Effect.succeed({ estimatedTokens: undefined, cacheWarm: false }),
            toolPrune: () => Effect.succeed({ status: "compacted" }),
            promptAndWait: ({ text }) =>
              Effect.gen(function* () {
                events.push("repair-handoff");
                const operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
                  source.worktreePath,
                );
                expect(operation).toMatchObject({
                  phase: scenario === "clean-rebase" ? "validating" : "resolving",
                  pauseReason: scenario === "clean-rebase" ? "clean-rebase" : "conflict",
                });
                if (scenario === "clean-rebase") {
                  expect(operation).not.toHaveProperty("conflictFiles");
                  expect(text).toContain("Automatic clean-rebase validation");
                  expect(text).toContain("No new commit is needed");
                  expect(text).not.toMatch(/conflict|repair|git status|rebase --continue|git add/i);
                } else {
                  expect(operation?.conflictFiles).toEqual(["feature.mjs"]);
                  expect(text).toContain("- feature.mjs");
                  expect(text).toContain("GIT_EDITOR=true git rebase --continue");
                  expect(text).toContain("Automatic landing repair");
                }
                expect(text).toContain("worktrees.reportReadiness");
                expect(text).toContain("Do not call worktrees.merge");
                expect((yield* families.state()).autoMergeRequests?.[0]?.readyToMerge).toBe(false);
                yield* Effect.tryPromise({
                  try: async () => {
                    expect(await head(root)).toBe(targetBeforeRepair);
                    const unmerged = (
                      await git(source.worktreePath, "diff", "--name-only", "--diff-filter=U")
                    ).stdout.trim();
                    expect(unmerged).toBe(scenario === "conflict" ? "feature.mjs" : "");
                    if (scenario === "conflict") {
                      await writeFile(
                        join(source.worktreePath, "feature.mjs"),
                        "export const feature = 'upstream+feature';\n",
                      );
                      await git(source.worktreePath, "add", "feature.mjs");
                      await exec("git", ["rebase", "--continue"], {
                        cwd: source.worktreePath,
                        env: { ...process.env, GIT_EDITOR: "true" },
                      });
                    }
                    await git(source.worktreePath, "diff", "--check");
                    const check = await exec(
                      process.execPath,
                      ["--test", "--test-reporter=tap", "feature.test.mjs", "upstream.test.mjs"],
                      { cwd: source.worktreePath },
                    );
                    expect(check.stdout).toContain("# pass 2");
                    validated = await head(source.worktreePath);
                    expect(validated).not.toBe(original);
                    events.push("scoped-validation-passed");
                  },
                  catch: (error) =>
                    new WorktreeLandingAgentError({ operation: "repair", message: String(error) }),
                });
                executingTurn = "repair-turn";
                expect(yield* report(target, ready(validated))).toEqual({ eligible: true });
                if (ending === "revoked") yield* setEnabled(root, false);
                events.push("fresh-readiness");
                const hooks = yield* makeTurnLifecycle({
                  sessionId: "owner",
                  location: {
                    projectPath: root,
                    projectName: "Fixture",
                    workingDirectory: source.worktreePath,
                    sessionDirectory: "/sessions",
                    resolvedSessionDirectory: "/resolved",
                  },
                });
                yield* hooks.onTurnSettled({
                  sessionId: "owner",
                  turnId: "repair-turn",
                  outcome: ending === "aborted" ? "aborted" : "complete",
                  result: {
                    stopReason: "stop",
                    text: "Repaired both requirements, committed final changes, and the scoped acceptance test passed.",
                  },
                });
                return ending === "aborted" ? ("aborted" as const) : ("complete" as const);
              }).pipe(
                Effect.provide(context),
                Effect.mapError(
                  (error) =>
                    new WorktreeLandingAgentError({ operation: "repair", message: String(error) }),
                ),
              ),
          });
          const pass = runPass().pipe(Effect.provideService(WorktreeLandingAgent, agent));
          const terminal = SubscriptionRef.changes(coordinator.state).pipe(
            Stream.filter((state) =>
              ["stalled", "landed", "failed"].includes(
                state.operations.get(source.worktreePath)?.phase ?? "",
              ),
            ),
            Stream.runHead,
          );
          yield* setEnabled(root, true);
          yield* report(target, ready(original));
          yield* families.updateAutoMerge("task-turn", "ready");
          yield* pass;
          expect(
            (yield* SubscriptionRef.get(coordinator.state)).operations.has(source.worktreePath),
            JSON.stringify((yield* families.state()).autoMergeRequests),
          ).toBe(true);
          yield* terminal;
          expect(events).toEqual(["repair-handoff", "scoped-validation-passed", "fresh-readiness"]);
          if (ending === "canceled") yield* cancel(source.worktreePath, "task-turn");
          if (ending !== "complete") {
            yield* pass;
            yield* pass;
            expect(events).not.toContain("landed-notice");
            expect(events).not.toContain("resolve");
            const requests = (yield* families.state()).autoMergeRequests;
            expect(requests?.some((request) => request.state === "landed")).toBe(false);
            return;
          }
          // Scheduler passes alone resume: no merge, Retry or resolve tool invocation.
          yield* pass;
          yield* terminal;
          yield* pass;
          yield* pass;
          yield* pass;
          const requests = (yield* families.state()).autoMergeRequests;
          expect(requests?.[0]).toMatchObject({ commit: original, readyToMerge: false });
          expect(requests?.[1]).toMatchObject({
            commit: validated,
            repairAttempt: 1,
            repairOfRequestId: "task-turn",
            state: "landed",
          });
          expect(events).toEqual([
            "repair-handoff",
            "scoped-validation-passed",
            "fresh-readiness",
            "landed-notice",
            "resolve",
          ]);
        }).pipe(Effect.provide(dependencies)),
      );
      expect(await head(root)).toBe(ending === "complete" ? validated : targetBeforeRepair);
      if (ending === "complete")
        await exec(process.execPath, ["--test", "feature.test.mjs", "upstream.test.mjs"], {
          cwd: root,
        });
    } finally {
      const records = await engine.records().catch(() => []);
      for (const record of records)
        await engine.discard(record.worktreePath, false).catch(() => undefined);
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it(
  "reports the real checkout HEAD and every file that would block readiness",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-readiness-head-"));
    const engine = makeTestWorktreeService(join(root, ".git", "cake-test-worktrees.json"));
    const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });
    const headState = (path: string) =>
      engine.run(Effect.flatMap(ManagedWorktrees, (service) => service.headState(path)));
    try {
      await git(root, "init", "-b", "main");
      await git(root, "config", "user.email", "cake@example.test");
      await git(root, "config", "user.name", "Cake Test");
      await writeFile(join(root, "tracked.txt"), "base\n");
      await git(root, "add", "tracked.txt");
      await git(root, "commit", "-m", "base");
      const source = await engine.create(root);
      const head = (await git(source.worktreePath, "rev-parse", "HEAD")).stdout.trim();
      expect(await headState(source.worktreePath)).toEqual({
        head,
        changedFiles: [],
        merging: false,
        rebasing: false,
      });
      await writeFile(join(source.worktreePath, "tracked.txt"), "changed\n");
      await writeFile(join(source.worktreePath, "untracked.txt"), "new\n");
      expect((await headState(source.worktreePath))?.changedFiles.toSorted()).toEqual([
        "tracked.txt",
        "untracked.txt",
      ]);
      expect(await headState(join(root, "not-managed"))).toBeUndefined();
    } finally {
      const records = await engine.records().catch(() => []);
      for (const record of records)
        await engine.discard(record.worktreePath, false).catch(() => undefined);
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
