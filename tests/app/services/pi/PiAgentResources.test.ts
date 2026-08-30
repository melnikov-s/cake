import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, it as vitestIt } from "vitest";
import {
  makePiAgentResourcesLayer,
  PiAgentResources,
} from "../../../../src/services/pi/PiAgentResources";
import type { PiAgentResourcesSnapshot } from "../../../../src/services/pi/agent-resource-data";
import { discoverPiAgentResources } from "../../../../src/services/pi/live/PiAgentResourcesLive";

const context = {
  workingDirectory: "/project",
  projectTrusted: true,
};

const snapshot: PiAgentResourcesSnapshot = {
  skills: [],
  promptTemplates: [],
  extensionSources: [],
  packageSources: [],
  diagnostics: [],
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("PiAgentResources", () => {
  it.effect("loads and explicitly reloads a validated context-dependent snapshot", () => {
    const operations: string[] = [];
    const layer = makePiAgentResourcesLayer({
      load: (input) =>
        Effect.sync(() => {
          operations.push(input.workingDirectory);
          return snapshot;
        }),
    });
    return Effect.gen(function* () {
      const resources = yield* PiAgentResources;
      const result = [yield* resources.load(context), yield* resources.reload(context)] as const;
      assert.deepEqual(result, [snapshot, snapshot]);
      assert.deepEqual(operations, ["/project", "/project"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts resource discovery when its caller is cancelled", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const layer = makePiAgentResourcesLayer({
        load: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const operation = Effect.gen(function* () {
        return yield* (yield* PiAgentResources).load(context);
      }).pipe(Effect.provide(layer));
      const fiber = yield* Effect.forkChild(operation);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("reports typed adapter and projection failures", () =>
    Effect.gen(function* () {
      const failed = makePiAgentResourcesLayer({
        load: () => Effect.fail(new Error("resource discovery failed")),
      });
      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* PiAgentResources).reload(context));
      }).pipe(Effect.provide(failed));
      assert.equal(failure._tag, "PiAgentResourcesError");
      assert.equal(failure.operation, "reload");
      assert.match(failure.message, /resource discovery failed/);

      const malformed = makePiAgentResourcesLayer({
        load: () =>
          Effect.succeed({
            ...snapshot,
            skills: [{ invalid: true }],
          }),
      });
      const malformedFailure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* PiAgentResources).load(context));
      }).pipe(Effect.provide(malformed));
      assert.equal(malformedFailure._tag, "PiAgentResourcesError");
      assert.equal(malformedFailure.operation, "load");
    }),
  );

  vitestIt(
    "discovers configured Pi package skills and prompt templates without exposing commands",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cake-pi-resources-"));
      temporaryDirectories.push(directory);
      const agentDirectory = join(directory, "agent");
      const packageDirectory = join(directory, "fixture-package");
      await mkdir(join(directory, ".pi"), { recursive: true });
      await mkdir(join(packageDirectory, "skills", "fixture-skill"), { recursive: true });
      await mkdir(join(packageDirectory, "prompts"), { recursive: true });
      await mkdir(join(packageDirectory, "extensions"), { recursive: true });
      await mkdir(agentDirectory, { recursive: true });
      await writeFile(
        join(directory, ".pi", "settings.json"),
        JSON.stringify({ packages: [packageDirectory] }),
      );
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({
          name: "cake-resource-fixture",
          version: "1.0.0",
          pi: {
            skills: ["skills"],
            prompts: ["prompts"],
            extensions: ["extensions/fixture.ts"],
          },
        }),
      );
      await writeFile(
        join(packageDirectory, "skills", "fixture-skill", "SKILL.md"),
        "---\nname: fixture-skill\ndescription: Fixture skill\n---\nUse the fixture.\n",
      );
      await writeFile(
        join(packageDirectory, "prompts", "fixture-prompt.md"),
        "---\ndescription: Fixture prompt\n---\nFixture prompt body.\n",
      );
      await writeFile(
        join(packageDirectory, "extensions", "fixture.ts"),
        "export default function (pi) { pi.registerCommand('fixture-command', { description: 'Fixture', handler: async () => undefined }); }\n",
      );

      const result = await discoverPiAgentResources(agentDirectory, {
        workingDirectory: directory,
        projectTrusted: true,
      });

      assert.ok(result.skills.some((skill) => skill.name === "fixture-skill"));
      assert.ok(result.promptTemplates.some((prompt) => prompt.name === "fixture-prompt"));
      assert.ok(result.packageSources.some((source) => source.source === packageDirectory));
      const extension = result.extensionSources.find((source) =>
        source.path.endsWith("fixture.ts"),
      );
      assert.ok(extension);
      assert.equal("commands" in extension, false);
    },
  );
});
