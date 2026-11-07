import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect } from "vitest";
import { resolveCakePaths } from "../../../../src/config/CakePaths";
import { makeModelPresetPrompts } from "../../../../src/services/storage/ModelPresetPrompts";
import { loadPresetContext } from "../../../../src/services/storage/load-preset-context";
import { presetGuidance } from "../../../../src/contracts/model-presets/preset-context";
import { createCakeSessionRuntimeConfigurationState } from "../../../../src/services/pi/runtime/cake-session-runtime-configuration";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe("ModelPresetPrompts", () => {
  it.effect(
    "uses CAKE_HOME, keeps exact contents and independent files, and reloads external edits at runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const paths = resolveCakePaths({
          env: { CAKE_HOME: home },
          piAgentDirectory: path.join(home, "pi-agent"),
        });
        const prompts = makeModelPresetPrompts(fs, path, paths.prompts);
        const text = "  # Guidance\r\n\r\nBe precise 🎂\n  ";
        const first = yield* prompts.write(text);
        const second = yield* prompts.write("Different guidance.");
        expect(path.dirname(first)).toBe(paths.prompts);
        expect(path.extname(first)).toBe(".md");
        expect(first).not.toBe(second);
        expect(yield* prompts.read(first)).toBe(text);
        yield* prompts.write("", first);
        expect(yield* prompts.read(first)).toBe("");
        expect(yield* prompts.read(second)).toBe("Different guidance.");
        yield* fs.writeFileString(first, "Changed outside Cake.\r\n");
        expect(yield* prompts.read(first)).toBe("Changed outside Cake.\r\n");
        const preset = {
          id: "00000000-0000-4000-8000-000000000001",
          promptFile: first,
          prompt: "Stale snapshot",
        };
        const loaded = yield* Effect.tryPromise(() => loadPresetContext(preset));
        expect(loaded?.prompt).toBe("Changed outside Cake.\r\n");
        expect(presetGuidance(loaded)).toContain("Changed outside Cake.");

        const manager = SessionManager.inMemory(home);
        const state = createCakeSessionRuntimeConfigurationState(undefined, () => ({
          presets: [
            {
              id: preset.id,
              promptFile: first,
              name: "Review",
              provider: "example",
              modelId: "same-model",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
        }));
        state.attachSession(manager);
        // An existing Pi session can still contain the pre-migration inline snapshot.
        state.setPreset({ id: preset.id, prompt: "Old inline session guidance." });
        expect(state.preset()).toEqual({ id: preset.id, promptFile: first });
        type Event = { systemPromptOptions: { sections: Record<string, string> } };
        let prepare: ((event: Event) => Promise<void>) | undefined;
        const pi = {
          on: (name: string, handler: (event: Event) => Promise<void>) => {
            if (name === "before_agent_start") prepare = handler;
          },
        };
        void (state.fastModeExtension as ExtensionFactory)(pi as unknown as ExtensionAPI);
        const sections: Record<string, string> = { shared: "Shared instructions." };
        yield* Effect.tryPromise(() => prepare!({ systemPromptOptions: { sections } }));
        expect(sections.model_preset).toContain("Changed outside Cake.");
        yield* fs.writeFileString(first, "Next turn guidance.");
        yield* Effect.tryPromise(() => prepare!({ systemPromptOptions: { sections } }));
        expect(sections.model_preset).toContain("Next turn guidance.");
        expect(sections.shared).toBe("Shared instructions.");
      }).pipe(Effect.provide(platform)),
  );

  it.effect(
    "reports missing/unreadable files and rejected references without substituting cached text",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const root = path.join(home, "prompts");
        const prompts = makeModelPresetPrompts(fs, path, root);
        const missing = path.join(root, "missing.md");
        const error = yield* Effect.flip(prompts.read(missing));
        expect(error.message).toContain(`Could not read preset prompt ${missing}`);
        const runtime = yield* Effect.result(
          Effect.tryPromise(() =>
            loadPresetContext({
              id: "00000000-0000-4000-8000-000000000001",
              promptFile: missing,
              prompt: "Must not fall back.",
            }),
          ),
        );
        expect(runtime._tag).toBe("Failure");
        const invalid = yield* Effect.flip(prompts.write("text", path.join(home, "outside.md")));
        expect(invalid.message).toContain(`under ${root}`);
        const wrongExtension = yield* Effect.flip(
          prompts.write("text", path.join(root, "prompt.txt")),
        );
        expect(wrongExtension.message).toContain("Markdown file");
        yield* fs.makeDirectory(missing, { recursive: true });
        expect((yield* Effect.flip(prompts.write("text", missing))).message).toContain(missing);
      }).pipe(Effect.provide(platform)),
  );
});
