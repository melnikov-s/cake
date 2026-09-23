import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import type { ProjectSessionControlInvocation } from "../../../src/domain/project-sessions/project-session-data";
import type { JsonValue } from "../../../src/ipc/json-contract";
import { EditorSelectionId } from "../../../src/ipc/editor-selection";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};
function environment(
  requestApplicationControl: (
    invocation: ProjectSessionControlInvocation,
    signal: AbortSignal,
  ) => Promise<JsonValue>,
) {
  return Layer.mergeAll(
    makeProjectSessionRuntimeMechanismTestLayer({
      requestApplicationControl,
      requestUi: async () => undefined,
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact persistence");
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
    }),
    familyStorageHarness().layer,
    SessionCatalogChanges.layer,
    Layer.mock(CakeSessionRuntimes, {}),
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
    Layer.mock(ApplicationState, { snapshot: () => defaultApplicationState() }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
  );
}

describe("Project Session runtime renderer-owned VS Code controls", () => {
  it.effect(
    "routes entry, ranged open and collection operations through renderer controls with validated replies",
    () => {
      const calls: ProjectSessionControlInvocation[] = [];
      const id = EditorSelectionId.make("selection-one");
      const reveal = {
        outcome: { view: "file" as const },
        locations: [
          {
            kind: "working-directory" as const,
            view: "file" as const,
            path: "src/main.ts",
            range: { start: { line: 3, column: 0 }, end: { line: 5, column: 12 } },
          },
        ],
      };
      const state = {
        sessionId: "session-a",
        selections: [{ id, location: reveal.locations[0]! }],
      };
      return Effect.gen(function* () {
        const options = yield* acquireOptions({
          location,
          sessionId: "session-a",
          newSession: false,
        });
        const control = options.runtime.vscodeControl!;
        const signal = new AbortController().signal;
        yield* Effect.promise(() => control.enter(signal));
        assert.deepEqual(
          yield* Effect.promise(() =>
            control.open(
              {
                kind: "working-directory",
                path: "src/main.ts",
                range: { start: { line: 3 }, end: { line: 5 } },
              },
              signal,
            ),
          ),
          { status: "completed", value: { reveal, selectionIds: [id] } },
        );
        assert.deepEqual(yield* Effect.promise(() => control.listSelections(signal)), state);
        assert.deepEqual(yield* Effect.promise(() => control.removeSelection(id, signal)), {
          state: { sessionId: "session-a", selections: [] },
        });
        yield* Effect.promise(() => control.clearSelections(signal));
        assert.deepEqual(calls, [
          { _tag: "InvokeAppControl", command: "vscode.enter", input: {} },
          {
            _tag: "InvokeAppControl",
            command: "vscode.open",
            input: { path: "src/main.ts", line: 4, endLine: 6 },
          },
          { _tag: "InvokeAppControl", command: "vscode.selections.list", input: {} },
          { _tag: "InvokeAppControl", command: "vscode.selections.remove", input: { id } },
          { _tag: "InvokeAppControl", command: "vscode.selections.clear", input: {} },
        ]);
      }).pipe(
        Effect.provide(
          environment(async (invocation, signal): Promise<JsonValue> => {
            assert.equal(signal.aborted, false);
            calls.push(invocation);
            assert.equal(invocation._tag, "InvokeAppControl");
            if (invocation.command === "vscode.open")
              return { ok: true, selection: { reveal, selectionIds: [id] } };
            if (invocation.command === "vscode.selections.list") return { ok: true, state };
            return { ok: true, update: { state: { sessionId: "session-a", selections: [] } } };
          }),
        ),
      );
    },
  );

  it.effect(
    "preserves mode-required, unavailable renderer and malformed-reply failures without a main collection",
    () => {
      let reply: JsonValue = {
        ok: false,
        error: "VSCODE_MODE_REQUIRED: Select the calling session",
      };
      return Effect.gen(function* () {
        const options = yield* acquireOptions({
          location,
          sessionId: "session-a",
          newSession: false,
        });
        const control = options.runtime.vscodeControl!;
        const signal = new AbortController().signal;
        assert.deepEqual(
          yield* Effect.promise(() =>
            control.open({ kind: "working-directory", path: "src/main.ts" }, signal),
          ),
          { status: "mode-required" },
        );
        reply = { ok: false, error: "Owning renderer unavailable" };
        yield* Effect.promise(() => assert.rejects(control.listSelections(signal), /unavailable/));
        reply = { ok: true, state: { sessionId: "session-a", selections: [{ id: "bad" }] } };
        yield* Effect.promise(() => assert.rejects(control.listSelections(signal)));
      }).pipe(Effect.provide(environment(async () => reply)));
    },
  );
});
