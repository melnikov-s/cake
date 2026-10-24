import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vitest";
import {
  loadDesktopSharingPreferences,
  saveDesktopSharingPreferences,
} from "../../../../src/services/storage/desktop-sharing-preferences";

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);

it.effect(
  "durably round-trips connection preferences, omits enablement, and clears the origin",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-sharing-prefs-" });
      expect(yield* loadDesktopSharingPreferences(directory)).toEqual({
        bind: "127.0.0.1",
        port: 4317,
      });
      const preferences = {
        bind: "127.0.0.2",
        port: 0,
        publicOrigin: "https://laptop.example:8443",
      };
      yield* saveDesktopSharingPreferences(directory, preferences);
      // A fresh read of disk, with no cached Store/service instance, is the startup boundary.
      expect(yield* loadDesktopSharingPreferences(directory)).toEqual(preferences);
      const stored = JSON.parse(yield* fs.readFileString(`${directory}/desktop-sharing.json`));
      expect(stored).toEqual({ version: 1, preferences });
      yield* saveDesktopSharingPreferences(directory, { bind: "127.0.0.1", port: 4321 });
      expect(yield* loadDesktopSharingPreferences(directory)).toEqual({
        bind: "127.0.0.1",
        port: 4321,
      });
      expect(yield* fs.readDirectory(directory)).toEqual(["desktop-sharing.json"]);
    }).pipe(Effect.scoped, Effect.provide(platform)),
);

it.effect("rejects invalid origins before replacing the last durable preferences", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-sharing-prefs-" });
    const preferences = { bind: "127.0.0.1", port: 4317, publicOrigin: "https://valid.example" };
    yield* saveDesktopSharingPreferences(directory, preferences);
    const failure = yield* saveDesktopSharingPreferences(directory, {
      ...preferences,
      publicOrigin: "http://invalid.example",
    }).pipe(Effect.flip);
    expect(failure._tag).toBe("DesktopSharingError");
    expect(yield* loadDesktopSharingPreferences(directory)).toEqual(preferences);
    yield* fs.writeFileString(`${directory}/desktop-sharing.json`, "{invalid");
    expect((yield* loadDesktopSharingPreferences(directory).pipe(Effect.flip)).message).toContain(
      "Could not read",
    );
    // Corruption is surfaced, never silently replaced by defaults at startup.
    expect(yield* fs.readFileString(`${directory}/desktop-sharing.json`)).toBe("{invalid");
  }).pipe(Effect.scoped, Effect.provide(platform)),
);
