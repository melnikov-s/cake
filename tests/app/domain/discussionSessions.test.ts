import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import * as discussionSessions from "../../../src/domain/discussionSessions";
import {
  makeDiscussionSessionEnvironmentLayer,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import { makePiSessionsLayer, type PiSessionsAdapter } from "../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import { makeProjectSessionEnvironmentLayer } from "../../../src/services/project-sessions/ProjectSessionEnvironment";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { defaultApplicationState } from "../../../src/domain/application-data";

const makeSnapshot = (sessionId: string, sessionFile: string): SessionSnapshot => ({
  workspacePath: "/project",
  sessionId,
  sessionFile,
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
});

const anchor = {
  path: "src/app.ts",
  view: "file" as const,
  start: { diffLine: 1, newLine: 4 },
  end: { diffLine: 1, newLine: 4 },
  selectedText: "value",
  contextBefore: "const ",
  contextAfter: " = 1",
  diff: "+value",
};

const makeLayer = () => {
  let record: DiscussionSessionRecord = {
    id: "thread-1",
    workingDirectory: "/project",
    parentSessionId: "parent-1",
    pendingParts: [
      {
        id: "pending-question",
        kind: "text",
        role: "user",
        text: "Why is this exported?",
        status: "complete",
        deliveryState: "sending",
      },
    ],
    anchor,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const runtimeOptions: CakeRuntimeOptions[] = [];
  let preparedContexts = 0;
  const runtime = (options: CakeRuntimeOptions): CakeRuntime => {
    const sessionId = options.sessionId ?? "generated";
    const sessionFile = options.auxiliary
      ? `/reviews/${sessionId}.jsonl`
      : `/sessions/${sessionId}.jsonl`;
    return {
      sessionId,
      sessionFile,
      streaming: false,
      getReviewParentContext: options.auxiliary
        ? undefined
        : () => ({
            sessionId,
            sessionFile,
            leafId: "leaf-1",
          }),
      snapshot: async () => makeSnapshot(sessionId, sessionFile),
      prompt: async () => {
        options.onEvent({ type: "streaming", sessionId, streaming: false });
      },
      compact: async () => undefined,
      abort: async () => undefined,
      setModel: async () => undefined,
      setThinkingLevel: async () => undefined,
      applyConfiguration: async () => undefined,
      setPiSetting: async () => undefined,
      recordReviewRun: () => undefined,
      login: async () => undefined,
      logout: async () => undefined,
      rename: async () => undefined,
      fork: async () => ({ sessionId: "fork", sessionFile: "/fork.jsonl" }),
      handoff: async () => ({ sessionId: "handoff", sessionFile: "/handoff.jsonl" }),
      navigate: async () => undefined,
      dispose: () => undefined,
    };
  };
  const adapter: PiSessionsAdapter = {
    list: () => Effect.succeed([]),
    inspect: () => Effect.succeed(undefined),
    createRuntime: (options) =>
      Effect.sync(() => {
        runtimeOptions.push(options);
        return runtime(options);
      }),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const discussions = makeDiscussionSessionEnvironmentLayer({
    list: () => Effect.succeed([record]),
    get: () => Effect.succeed(record),
    create: () => Effect.succeed(record),
    linkSidecar: (current, sidecar) =>
      Effect.sync(() => {
        record = {
          ...current,
          sidecarSessionId: sidecar.sessionId,
          sidecarSessionFile: sidecar.sessionFile,
        };
        return record;
      }),
    setResolved: (current, resolved) =>
      Effect.sync(() => {
        record = { ...current, status: resolved ? "resolved" : "open" };
        return record;
      }),
    location: () =>
      Effect.succeed({
        agentDirectory: "/cake",
        sessionDirectory: "/cake/reviews/thread-1",
        parentSessionDirectory: "/cake/sessions",
        trusted: true,
      }),
    prepareParentContext: () =>
      Effect.sync(() => {
        preparedContexts += 1;
        return "Read the bounded parent projection at /cake/reviews/context/parent.md";
      }),
    refreshParentIndex: () => Effect.void,
  });
  const projects = makeProjectSessionEnvironmentLayer({
    locations: () =>
      Effect.succeed([
        {
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/project",
          sessionDirectory: "/cake/sessions",
          resolvedSessionDirectory: "/cake/resolved",
        },
      ]),
    runtimeOptions: ({ location, sessionId, newSession }) =>
      Effect.succeed({
        profile: { _tag: "ProjectSession" },
        runtime: {
          cwd: location.workingDirectory,
          trusted: true,
          agentDir: "/cake",
          sessionDir: location.sessionDirectory,
          sessionId,
          newSession,
          requestUi: async () => undefined,
        },
      }),
    archive: () => Effect.void,
    restore: (_sessionId, location) => Effect.succeed(location),
    forkToWorkingDirectory: () => Effect.succeed("fork"),
  });
  return {
    layer: Layer.mergeAll(
      makePiSessionsLayer(adapter),
      discussions,
      projects,
      Layer.mock(ApplicationState, {
        snapshot: defaultApplicationState,
        refreshProjection: () => Effect.void,
      }),
    ),
    options: runtimeOptions,
    preparedContexts: () => preparedContexts,
    record: () => record,
  };
};

describe("Discussion Sessions domain", () => {
  it.effect("projects Cake-owned pending comments before a sidecar transcript exists", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const threads = yield* discussionSessions.list({
        workingDirectory: "/project",
        parentSessionId: "parent-1",
      });
      assert.equal(threads.length, 1);
      assert.deepEqual(threads[0]?.parts, fixture.record().pendingParts);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("regenerates parent context and uses a constrained shared Pi runtime", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const accepted = yield* discussionSessions.prompt({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "thread-1",
        text: "Explain this",
      });
      assert.match(accepted.turnId, /^[0-9a-f-]{36}$/);
      assert.equal(fixture.preparedContexts(), 1);
      assert.equal(fixture.record().sidecarSessionId !== undefined, true);
      const sidecar = fixture.options.find((options) => options.auxiliary);
      assert.deepEqual(sidecar?.tools, ["read", "grep", "find", "ls"]);
      assert.equal(sidecar?.additionalSystemPrompt?.includes("bounded parent"), true);
      assert.equal(sidecar?.globalControl, undefined);

      yield* discussionSessions.prompt({
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        threadId: "thread-1",
        text: "And now?",
      });
      assert.equal(fixture.preparedContexts(), 2);
    }).pipe(Effect.provide(fixture.layer));
  });
});
