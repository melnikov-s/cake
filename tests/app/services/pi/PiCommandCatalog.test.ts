import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, it as vitestIt } from "vitest";
import {
  makePiCommandCatalogLayer,
  PiCommandCatalog,
} from "../../../../src/services/pi/PiCommandCatalog";
import { discoverPiCommands } from "../../../../src/services/pi/live/PiCommandCatalogLive";

const context = {
  workingDirectory: "/project",
  projectTrusted: true,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("PiCommandCatalog", () => {
  it.effect("validates discovered commands at the Pi service boundary", () => {
    const layer = makePiCommandCatalogLayer({
      load: () =>
        Effect.succeed([
          {
            name: "fixture",
            description: "Fixture command",
            source: "extension",
            sourceInfo: {
              path: "/project/fixture.ts",
              source: "fixture.ts",
              scope: "project",
              origin: "top-level",
            },
          },
        ]),
    });
    return Effect.gen(function* () {
      const commands = yield* (yield* PiCommandCatalog).load(context);
      assert.equal(commands[0]?.name, "fixture");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects malformed command projections", () => {
    const layer = makePiCommandCatalogLayer({
      load: () => Effect.succeed([{ name: "fixture", source: "unknown" }]),
    });
    return Effect.gen(function* () {
      const failure = yield* Effect.flip((yield* PiCommandCatalog).load(context));
      assert.equal(failure._tag, "PiCommandCatalogError");
    }).pipe(Effect.provide(layer));
  });

  vitestIt(
    "discovers built-in, extension, prompt, and skill commands without a session",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cake-pi-command-catalog-"));
      temporaryDirectories.push(directory);
      const agentDirectory = join(directory, "agent");
      const skillDirectory = join(directory, ".agents", "skills", "fixture-skill");
      const promptDirectory = join(directory, ".pi", "prompts");
      const extensionDirectory = join(directory, ".pi", "extensions");
      await Promise.all([
        mkdir(agentDirectory, { recursive: true }),
        mkdir(skillDirectory, { recursive: true }),
        mkdir(promptDirectory, { recursive: true }),
        mkdir(extensionDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(skillDirectory, "SKILL.md"),
          "---\nname: fixture-skill\ndescription: Fixture skill\n---\nFixture.\n",
        ),
        writeFile(
          join(promptDirectory, "fixture-prompt.md"),
          "---\ndescription: Fixture prompt\n---\nFixture.\n",
        ),
        writeFile(
          join(extensionDirectory, "fixture.ts"),
          "export default function (pi) { pi.registerCommand('fixture-extension', { description: 'Fixture extension', handler: async () => undefined }); }\n",
        ),
      ]);

      const commands = await discoverPiCommands(agentDirectory, {
        workingDirectory: directory,
        projectTrusted: true,
      });

      assert.ok(commands.some((command) => command.name === "model"));
      assert.ok(commands.some((command) => command.name === "fixture-extension"));
      assert.ok(commands.some((command) => command.name === "fixture-prompt"));
      assert.ok(commands.some((command) => command.name === "skill:fixture-skill"));
    },
  );
});
