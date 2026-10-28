import { Effect, Option, Stream } from "effect";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import * as workflowLifecycle from "../workflows/workflow-lifecycle";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import {
  SessionFamilyStorage,
  familyMemberIds,
  familyMember,
} from "../../services/storage/SessionFamilyStorage";
import { defaultProjectSettings } from "../../contracts/application/application-data";
import { getState, revokeProjectTrust, trustProject } from "../application/application";
import { generateWorktreeName, utilityModelSelection } from "../utility-work/utilityWork";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveMigrationSource,
} from "../../services/storage/SessionArchiveStorage";
import { Terminal } from "../../services/terminal/Terminal";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import * as worktreeCreation from "./worktreeCreation";
import * as worktreeLifecycle from "./worktreeLifecycle";
import type { ResolvedManagedWorktreeCleanupFailure } from "../../contracts/worktrees/managed-worktree-cleanup-data";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";

const policyError = (operation: string, cause: unknown) =>
  new ManagedWorktreeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const requireAllowed = Effect.fn("ManagedWorktrees.requireAllowed")(function* (
  workingDirectory: string,
) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(workingDirectory)))
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireAllowed",
      message: "Project path was not selected by the user",
    });
});

const requireRecord = Effect.fn("ManagedWorktrees.requireRecord")(function* (
  workingDirectory: string,
  allowedStates: ReadonlySet<"active" | "landed">,
) {
  const service = yield* ManagedWorktrees;
  const record = (yield* service.records()).find((candidate) => {
    const state = candidate.state ?? "active";
    return (
      candidate.worktreePath === workingDirectory &&
      ((state === "active" && allowedStates.has("active")) ||
        (state === "landed" && allowedStates.has("landed")))
    );
  });
  if (!record)
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireRecord",
      message: "Cake could not find that worktree",
    });
  return record;
});

export const create = Effect.fn("ManagedWorktrees.create")(function* (input: {
  readonly projectPath: string;
  readonly baseWorktreePath?: string;
  readonly worktreeName?: string;
  readonly firstUserMessage?: string;
  readonly backgroundSetup?: boolean;
}) {
  yield* requireAllowed(input.projectPath);
  const state = yield* getState();
  let worktreeName = input.worktreeName;
  if (!worktreeName && input.firstUserMessage && state.utilityModel) {
    worktreeName = yield* generateWorktreeName({
      selection: utilityModelSelection(state.utilityModel),
      firstUserMessage: input.firstUserMessage,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  }
  const settings =
    state.projects.find((project) => project.path === input.projectPath)?.settings ??
    defaultProjectSettings();
  const record = yield* worktreeCreation.createCheckout(
    input.projectPath,
    input.baseWorktreePath,
    worktreeName,
    settings,
    input.backgroundSetup,
  );
  const access = yield* ProjectAccess;
  yield* access
    .allow(record.worktreePath)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)));
  if (state.trustedProjectPaths.includes(record.projectPath))
    yield* trustProject(record.worktreePath).pipe(
      Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)),
    );
  return record;
});

export const discard = Effect.fn("ManagedWorktrees.discard")(function* (
  workingDirectory: string,
  keepBranch: boolean,
) {
  const record = yield* requireRecord(workingDirectory, new Set(["active", "landed"]));
  if (yield* workflowLifecycle.hasActive({ workingDirectory }))
    return yield* new ManagedWorktreeError({
      operation: "discard",
      message: "Stop active workflows before discarding their Working Directory.",
    });
  yield* (yield* Terminal)
    .closeWorkingDirectory(workingDirectory)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.discard", cause)));
  const { lifecycle } = yield* worktreeLifecycle.forProject(record.projectPath);
  yield* (yield* ManagedWorktrees).discard(workingDirectory, keepBranch, lifecycle);
  yield* revokeProjectTrust(workingDirectory).pipe(
    Effect.mapError((cause) => policyError("ManagedWorktrees.discard", cause)),
  );
});

const resolvedEntriesForProject = Effect.fn("ManagedWorktrees.resolvedEntriesForProject")(
  function* (projectPath: string) {
    const state = yield* getState();
    const project = state.projects.find((candidate) => candidate.path === projectPath);
    if (!project)
      return yield* new ManagedWorktreeError({
        operation: "ManagedWorktrees.resolvedEntriesForProject",
        message: "Cake could not find that Project",
      });
    yield* requireAllowed(projectPath);
    const archive = yield* SessionArchiveStorage;
    const locations = yield* projectSessionLocations
      .locations({ includeInactive: true })
      .pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      );
    const migrationComplete = yield* archive
      .projectMigrationComplete(projectPath)
      .pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      );
    const entries = migrationComplete
      ? archive.resolvedProjects(projectPath)
      : archive.migrateProject(
          projectPath,
          project.name,
          locations
            .filter((location) => location.projectPath === projectPath)
            .map((location) => {
              const source: ProjectSessionArchiveMigrationSource = {
                location: {
                  cwd: location.workingDirectory,
                  activeRoot: location.sessionDirectory,
                  resolvedRoot: location.resolvedSessionDirectory,
                },
              };
              if (location.managedWorktree)
                Object.assign(source, {
                  worktreeName: location.managedWorktree.branch.replace(/^agent\//, ""),
                });
              return source;
            }),
        );
    return {
      locations,
      entries: yield* entries.pipe(
        Stream.filterEffect((entry) =>
          resolutionNamespace(entry.sessionId, {
            cwd: entry.workingDirectory,
            activeRoot: entry.activeRoot,
            resolvedRoot: entry.resolvedRoot,
          }).pipe(Effect.map((namespace) => namespace === "resolved")),
        ),
        Stream.runCollect,
        Effect.map((items) => Array.from(items)),
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      ),
    };
  },
);

const activeSessionInWorkingDirectory = Effect.fn(
  "ManagedWorktrees.activeSessionInWorkingDirectory",
)(function* (workingDirectory: string, sessionDirectory: string) {
  if (yield* workflowLifecycle.hasActive({ workingDirectory })) return true;
  const families = yield* (yield* SessionFamilyStorage)
    .list()
    .pipe(
      Effect.mapError((cause) =>
        policyError("ManagedWorktrees.activeSessionInWorkingDirectory", cause),
      ),
    );
  const configuration = yield* ProjectSessionConfiguration;
  // Membership, not physical transcript placement, determines family activity.
  // This also protects children archived independently by older installations.
  for (const family of families) {
    if (
      !familyMemberIds(family).some(
        (id) => familyMember(family, id)?.workingDirectory === workingDirectory,
      )
    )
      continue;
    if (
      (yield* resolutionNamespace(family.parentSessionId, {
        cwd: family.workingDirectory,
        activeRoot: sessionDirectory,
        resolvedRoot: configuration.resolvedSessionDirectory,
      }).pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.activeSessionInWorkingDirectory", cause),
        ),
      )) !== "resolved"
    )
      return true;
  }
  const familyIds = new Set(families.flatMap(familyMemberIds));
  const resolvedIds = yield* (yield* SessionArchiveStorage)
    .resolvedIds({
      cwd: workingDirectory,
      activeRoot: sessionDirectory,
      resolvedRoot: configuration.resolvedSessionDirectory,
    })
    .pipe(
      Effect.mapError((cause) =>
        policyError("ManagedWorktrees.activeSessionInWorkingDirectory", cause),
      ),
    );
  return yield* (yield* CakeSessionRuntimes)
    .catalog({ workingDirectory, sessionDirectory, excludedSessionIds: [...resolvedIds] })
    .pipe(
      Stream.filter((session) => !familyIds.has(session.id)),
      Stream.runHead,
      Effect.map(Option.isSome),
      Effect.mapError((cause) =>
        policyError("ManagedWorktrees.activeSessionInWorkingDirectory", cause),
      ),
    );
});

/** Landed checkouts retire with their sessions. Pull-request projects never land through Cake,
 * so their active checkouts are candidates too; the engine keeps any with uncommitted work. */
const retirable = (record: WorktreeRecord, landsThroughPullRequests: boolean) =>
  record.state === "landed" ||
  (landsThroughPullRequests && (record.state ?? "active") === "active");

const discoverResolvedForProject = Effect.fn("ManagedWorktrees.discoverResolvedForProject")(
  function* (projectPath: string) {
    const worktrees = yield* ManagedWorktrees;
    const { entries, locations } = yield* resolvedEntriesForProject(projectPath);
    const configuration = yield* ProjectSessionConfiguration;
    const families = yield* (yield* SessionFamilyStorage)
      .list()
      .pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.discoverResolvedForProject", cause),
        ),
      );
    const resolvedFamilies = yield* Effect.filter(
      families.filter((family) => family.projectPath === projectPath),
      (family) =>
        resolutionNamespace(family.parentSessionId, {
          cwd: family.workingDirectory,
          activeRoot: configuration.sessionDirectory,
          resolvedRoot: configuration.resolvedSessionDirectory,
        }).pipe(
          Effect.map((namespace) => namespace === "resolved"),
          Effect.mapError((cause) =>
            policyError("ManagedWorktrees.discoverResolvedForProject", cause),
          ),
        ),
    );
    const familyMembers = resolvedFamilies.flatMap((family) =>
      familyMemberIds(family).flatMap((id) => {
        const member = familyMember(family, id);
        return member ? [member] : [];
      }),
    );
    const resolvedWorkingDirectories = new Set(
      [...entries, ...familyMembers].map((entry) => entry.workingDirectory),
    );
    const { landsThroughPullRequests } = yield* worktreeLifecycle.forProject(projectPath);
    const candidates = (yield* worktrees.records()).filter(
      (record) =>
        record.projectPath === projectPath &&
        retirable(record, landsThroughPullRequests) &&
        resolvedWorkingDirectories.has(record.worktreePath),
    );
    const eligible = yield* Effect.forEach(candidates, (record) =>
      Effect.gen(function* () {
        const location = locations.find(
          (candidate) =>
            candidate.projectPath === projectPath &&
            candidate.workingDirectory === record.worktreePath,
        );
        if (!location)
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discoverResolvedForProject",
            message: `Cake could not locate Working Directory ${record.worktreePath}`,
          });
        return (yield* activeSessionInWorkingDirectory(
          location.workingDirectory,
          location.sessionDirectory,
        ))
          ? undefined
          : record.worktreePath;
      }),
    );
    return {
      entries,
      familyMembers,
      locations,
      workingDirectories: eligible.filter(
        (workingDirectory): workingDirectory is string => workingDirectory !== undefined,
      ),
    };
  },
);

/** Authoritatively previews landed Managed Worktrees containing only resolved sessions. */
export const inspectResolvedForProject = Effect.fn("ManagedWorktrees.inspectResolvedForProject")(
  function* (projectPath: string) {
    const discovered = yield* discoverResolvedForProject(projectPath);
    return { projectPath, workingDirectories: discovered.workingDirectories };
  },
);

/**
 * Rediscovers and discards eligible Managed Worktrees sequentially. Per-worktree
 * failures are returned so successful cleanup remains visible and retryable.
 */
export const discardResolvedForProject = Effect.fn("ManagedWorktrees.discardResolvedForProject")(
  function* (projectPath: string) {
    const discovered = yield* discoverResolvedForProject(projectPath);
    const worktrees = yield* ManagedWorktrees;
    const { lifecycle, landsThroughPullRequests } =
      yield* worktreeLifecycle.forProject(projectPath);
    const terminals = yield* Terminal;
    const catalogs = yield* SessionCatalogChanges;
    const discardedWorkingDirectories: string[] = [];
    const failures: ResolvedManagedWorktreeCleanupFailure[] = [];
    for (const workingDirectory of discovered.workingDirectories) {
      const outcome = yield* Effect.gen(function* () {
        const currentRecord = (yield* worktrees.records()).find(
          (record) =>
            record.projectPath === projectPath &&
            record.worktreePath === workingDirectory &&
            retirable(record, landsThroughPullRequests),
        );
        const location = discovered.locations.find(
          (candidate) =>
            candidate.projectPath === projectPath &&
            candidate.workingDirectory === workingDirectory,
        );
        if (
          !currentRecord ||
          !location ||
          (yield* activeSessionInWorkingDirectory(
            location.workingDirectory,
            location.sessionDirectory,
          ))
        )
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discardResolvedForProject",
            message: "Working Directory is no longer eligible for resolved worktree cleanup",
          });
        const runningProgramCount = yield* terminals.runningProgramCount(workingDirectory);
        if (runningProgramCount > 0)
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discardResolvedForProject",
            message: "Running terminal programs require confirmation before cleanup",
          });
        yield* terminals.closeWorkingDirectory(workingDirectory);
        // Resolved-session cleanup is not approval to destroy work added after landing.
        // Use the same safe, restorable retirement path as ordinary resolution.
        const retired = yield* worktrees.cleanupResolved(workingDirectory, {
          lifecycle,
          retireActive: landsThroughPullRequests,
        });
        if (!retired)
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discardResolvedForProject",
            message: "Cake kept this worktree because it has uncommitted changes",
          });
        yield* revokeProjectTrust(workingDirectory);
      }).pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.discardResolvedForProject", cause),
        ),
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure" as const, error }),
          onSuccess: () => ({ _tag: "Success" as const }),
        }),
      );
      if (outcome._tag === "Failure") {
        failures.push({ workingDirectory, message: outcome.error.message });
        continue;
      }
      discardedWorkingDirectories.push(workingDirectory);
      const entries = new Map(
        [...discovered.entries, ...discovered.familyMembers]
          .filter((entry) => entry.workingDirectory === workingDirectory)
          .map((entry) => [entry.sessionId, entry]),
      );
      for (const entry of entries.values())
        yield* catalogs.publish({
          _tag: "ProjectSessionChanged",
          sessionId: entry.sessionId,
          projectPath,
          workingDirectory,
          resolved: true,
        });
    }
    return { projectPath, discardedWorkingDirectories, failures };
  },
);

/** Retires a landed checkout once its final active Project Session has been resolved. */
export const cleanupResolved = Effect.fn("ManagedWorktrees.cleanupResolved")(function* (
  workingDirectory: string,
  sessionDirectory: string,
) {
  const worktrees = yield* ManagedWorktrees;
  const record = (yield* worktrees.records()).find(
    (candidate) => candidate.worktreePath === workingDirectory,
  );
  if (!record) return;
  const { lifecycle, landsThroughPullRequests } = yield* worktreeLifecycle.forProject(
    record.projectPath,
  );
  if (!retirable(record, landsThroughPullRequests)) return;

  if (yield* activeSessionInWorkingDirectory(workingDirectory, sessionDirectory)) return;

  yield* (yield* Terminal)
    .closeWorkingDirectory(workingDirectory)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.cleanupResolved", cause)));
  // An unlanded checkout with uncommitted work stays; the user still owns that work.
  if (
    !(yield* worktrees.cleanupResolved(workingDirectory, {
      lifecycle,
      retireActive: landsThroughPullRequests,
    }))
  )
    return;
  yield* revokeProjectTrust(workingDirectory).pipe(
    Effect.mapError((cause) => policyError("ManagedWorktrees.cleanupResolved", cause)),
  );
});

/** Recreates a checkout retired by resolution before its first transcript is restored. */
export const restoreResolved = Effect.fn("ManagedWorktrees.restoreResolved")(function* (
  workingDirectory: string,
) {
  const worktrees = yield* ManagedWorktrees;
  const record = (yield* worktrees.records()).find(
    (candidate) => candidate.worktreePath === workingDirectory && candidate.state === "resolved",
  );
  if (!record) return;
  const { lifecycle } = yield* worktreeLifecycle.forProject(record.projectPath);
  const restored = yield* worktrees.restoreResolved(workingDirectory, lifecycle);
  if (restored && (yield* getState()).trustedProjectPaths.includes(restored.projectPath))
    yield* trustProject(restored.worktreePath).pipe(
      Effect.mapError((cause) => policyError("ManagedWorktrees.restoreResolved", cause)),
    );
});
