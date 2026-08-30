import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, it } from "vitest";
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
  it("loads and explicitly reloads a validated context-dependent snapshot", async () => {
    const operations: string[] = [];
    const layer = makePiAgentResourcesLayer({
      load: async (input) => {
        operations.push(input.workingDirectory);
        return snapshot;
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resources = yield* PiAgentResources;
        return [yield* resources.load(context), yield* resources.reload(context)] as const;
      }).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(result, [snapshot, snapshot]);
    assert.deepEqual(operations, ["/project", "/project"]);
  });

  it("interrupts resource discovery when its caller is cancelled", async () => {
    let discoverySignal: AbortSignal | undefined;
    const layer = makePiAgentResourcesLayer({
      load: async (_input, signal) => {
        discoverySignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return snapshot;
      },
    });
    const controller = new AbortController();
    const running = Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* PiAgentResources).load(context);
      }).pipe(Effect.provide(layer)),
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await assert.rejects(running);
    assert.equal(discoverySignal?.aborted, true);
  });

  it("reports typed adapter and projection failures", async () => {
    const failed = makePiAgentResourcesLayer({
      load: async () => {
        throw new Error("resource discovery failed");
      },
    });
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* PiAgentResources).reload(context));
      }).pipe(Effect.provide(failed)),
    );
    assert.equal(failure._tag, "PiAgentResourcesError");
    assert.equal(failure.operation, "reload");
    assert.match(failure.message, /resource discovery failed/);

    const malformed = makePiAgentResourcesLayer({
      load: async () => ({ ...snapshot, skills: [{ invalid: true }] }) as never,
    });
    const malformedFailure = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.flip((yield* PiAgentResources).load(context));
      }).pipe(Effect.provide(malformed)),
    );
    assert.equal(malformedFailure._tag, "PiAgentResourcesError");
    assert.equal(malformedFailure.operation, "load");
  });

  it("discovers configured Pi package skills and prompt templates without exposing commands", async () => {
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
    const extension = result.extensionSources.find((source) => source.path.endsWith("fixture.ts"));
    assert.ok(extension);
    assert.equal("commands" in extension, false);
  });
});
