import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { NodePath } from "@effect/platform-node-shared";
import { dirname, basename } from "node:path";
import { WorkflowScripts } from "../../../src/services/pi/WorkflowScripts";
import { makeWorkflowScriptsLive } from "../../../src/services/pi/live/WorkflowScriptsLive";
import { parseWorkflowProgram } from "../../../src/services/pi/runtime/workflow-program";
import { makeWorkflowRunStorageLive } from "../../../src/services/storage/WorkflowRunStorageLive";
import { WorkflowRunStorage } from "../../../src/services/storage/WorkflowRunStorage";
import { checkpoint, runId, stepId } from "../helpers/workflowFixture";

const location = { projectPath: "/project", workingDirectory: "/project/packages/api" };
const source = (name = "audit") =>
  `export const meta = { name: "${name}", description: "Audit routes" };\nreturn args;`;
function memoryFiles(initial: Record<string, string> = {}, links: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const noop = FileSystem.makeNoop({});
  const fs = FileSystem.makeNoop({
    exists: (path) =>
      Effect.succeed(
        files.has(path) ||
          Object.hasOwn(links, path) ||
          [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      ),
    readFileString: (path) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : noop.readFileString(path),
    readLink: (path) =>
      Object.hasOwn(links, path) ? Effect.succeed(links[path] ?? "") : noop.readLink(path),
    readDirectory: (path) =>
      Effect.succeed(
        [...files.keys()].filter((file) => dirname(file) === path).map((file) => basename(file)),
      ),
    makeDirectory: () => Effect.void,
    writeFileString: (path, content) =>
      Effect.sync(() => {
        files.set(path, content);
      }),
    chmod: () => Effect.void,
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }),
    remove: (path) =>
      Effect.sync(() => {
        files.delete(path);
      }),
  });
  const platform = Layer.merge(NodePath.layer, Layer.succeed(FileSystem.FileSystem, fs));
  return {
    files,
    platform,
    scripts: makeWorkflowScriptsLive("/personal/workflows").pipe(Layer.provide(platform)),
    storage: makeWorkflowRunStorageLive("/state/workflows").pipe(Layer.provide(platform)),
  };
}

describe("Workflow script files", () => {
  it.effect("parses literal metadata without evaluating any model-written host code", () =>
    Effect.sync(() => {
      expect(parseWorkflowProgram(source()).meta.name).toBe("audit");
      expect(() =>
        parseWorkflowProgram(`export const meta = { name: process.exit(), description: "bad" };`),
      ).toThrow("literal");
    }),
  );
  it.effect("rejects dynamic metadata, module loading and invalid JavaScript before launch", () =>
    Effect.sync(() => {
      for (const code of [
        "export const meta = makeMeta();",
        `${source()}\nawait import('fs');`,
        `${source()}\nconst broken = ;`,
        `${source()}\nconst typed: string = 'a';`,
      ])
        expect(() => parseWorkflowProgram(code)).toThrow();
    }),
  );
  it.effect(
    "preserves source line numbers when removing the metadata declaration for sandbox execution",
    () =>
      Effect.sync(() => {
        const code = `export const meta = {\nname: "audit",\ndescription: "Audit"\n};\nreturn 3;`;
        expect(parseWorkflowProgram(code).body.split("\n")[4]).toBe("return 3;");
        expect(parseWorkflowProgram(code).body.length).toBe(code.length);
      }),
  );
  it.effect(
    "discovers nearest project definitions and lets them shadow personal definitions",
    () => {
      const fixture = memoryFiles({
        "/project/.cake/workflows/a.js": source(),
        "/project/packages/api/.cake/workflows/a.js": source(),
        "/personal/workflows/a.js": source(),
        "/personal/workflows/b.js": source("other"),
      });
      return Effect.gen(function* () {
        const found = yield* (yield* WorkflowScripts).list(location);
        expect(found.map((item) => [item.meta.name, item.path])).toEqual([
          ["audit", "/project/packages/api/.cake/workflows/a.js"],
          ["other", "/personal/workflows/b.js"],
        ]);
      }).pipe(Effect.provide(fixture.scripts));
    },
  );
  it.effect(
    "saves a frozen run program with parameterized input rather than copying live source edits",
    () => {
      const fixture = memoryFiles({ "/project/workflow.js": "edited later" });
      return Effect.gen(function* () {
        const saved = yield* (yield* WorkflowScripts).save(
          location,
          checkpoint().run.program,
          "saved-audit",
          "project",
        );
        expect(fixture.files.get(saved.path)).toContain("return args;");
        expect(fixture.files.get(saved.path)).not.toContain("edited later");
        expect(saved.meta.name).toBe("saved-audit");
      }).pipe(Effect.provide(fixture.scripts));
    },
  );
  it.effect(
    "refuses unsafe symlink save targets without writing outside the selected location",
    () => {
      const fixture = memoryFiles({}, { "/project/.cake": "/elsewhere" });
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          (yield* WorkflowScripts).save(location, checkpoint().run.program, "audit", "project"),
        );
        expect(result._tag).toBe("Failure");
        expect(fixture.files.size).toBe(0);
      }).pipe(Effect.provide(fixture.scripts));
    },
  );
});

describe("Workflow checkpoint storage", () => {
  it.effect(
    "round-trips versioned journals without persisting worker transcript projections",
    () => {
      const fixture = memoryFiles();
      return Effect.gen(function* () {
        const storage = yield* WorkflowRunStorage;
        yield* storage.save(checkpoint(), null);
        expect(Option.getOrThrow(yield* storage.load(runId))).toEqual(checkpoint());
        expect(fixture.files.get(`/state/workflows/${runId}.json`)).not.toContain('"parts"');
      }).pipe(Effect.provide(fixture.storage));
    },
  );
  it.effect(
    "atomically saves a new revision and rejects stale or duplicate creation writes",
    () => {
      const fixture = memoryFiles();
      return Effect.gen(function* () {
        const storage = yield* WorkflowRunStorage;
        const initial = checkpoint();
        yield* storage.save(initial, null);
        expect((yield* Effect.result(storage.save(initial, null)))._tag).toBe("Failure");
        const next = {
          ...initial,
          run: { ...initial.run, revision: 1, status: "paused" as const },
        };
        yield* storage.save(next, 0);
        expect((yield* Effect.result(storage.save(next, 0)))._tag).toBe("Failure");
        expect(Option.getOrThrow(yield* storage.load(runId)).run.status).toBe("paused");
        expect([...fixture.files.keys()].some((file) => file.endsWith(".tmp"))).toBe(false);
      }).pipe(Effect.provide(fixture.storage));
    },
  );
  it.effect(
    "reports malformed or unsupported-version checkpoints rather than resetting them",
    () => {
      const fixture = memoryFiles({
        [`/state/workflows/${runId}.json`]: JSON.stringify({
          version: 2,
          checkpoint: checkpoint(),
        }),
      });
      return Effect.gen(function* () {
        expect((yield* Effect.result((yield* WorkflowRunStorage).load(runId)))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.provide(fixture.storage));
    },
  );
  it.effect(
    "retains previous frozen programs and Pi references after a revised-source relaunch",
    () => {
      const fixture = memoryFiles();
      return Effect.gen(function* () {
        const storage = yield* WorkflowRunStorage;
        const value = {
          ...checkpoint(),
          previousPrograms: [checkpoint().run.program],
          workers: [
            {
              stepId,
              execution: 1,
              attempt: 1,
              reference: {
                sessionId: "00000000-0000-4000-8000-000000000103",
                workingDirectory: "/project",
              },
            },
          ],
        };
        yield* storage.save(value, null);
        expect(Option.getOrThrow(yield* storage.load(runId))).toEqual(value);
      }).pipe(Effect.provide(fixture.storage));
    },
  );
});
