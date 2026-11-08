import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { expect } from "vitest";
import { makeBackendLoggingLive } from "../../../../src/services/diagnostics/BackendLoggingLive";
import { installWindowResponsivenessDiagnostics } from "../../../../src/services/electron/window-responsiveness-diagnostics";

it.effect(
  "persists correlated stall/recovery/termination exactly once and disposes on closure",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-window-diagnostics-" });
      const contents = Object.assign(new EventEmitter(), { id: 42, getOSProcessId: () => 123 });
      const native = Object.assign(new EventEmitter(), { id: 7, webContents: contents });
      const window = native as unknown as BrowserWindow;
      let now = 100;
      yield* Effect.gen(function* () {
        const run = Effect.runSyncWith(yield* Effect.context<never>());
        const report = (record: unknown) => run(Effect.logInfo("Cake renderer lifecycle", record));
        const dispose = installWindowResponsivenessDiagnostics(window, 9, report, () => now);
        expect(installWindowResponsivenessDiagnostics(window, 9, report)).toBe(dispose);
        native.emit("responsive");
        native.emit("unresponsive");
        native.emit("unresponsive");
        now = 1600;
        native.emit("responsive");
        native.emit("responsive");
        contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });
        contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 137 });
        contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
        native.emit("closed");
        dispose();
        native.emit("unresponsive");
        contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      }).pipe(Effect.provide(makeBackendLoggingLive(directory, "desktop")));
      const text = yield* fs.readFileString(path.join(directory, "desktop.log"));
      const records = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(4);
      expect(text).toContain('"durationMs":1500');
      expect(text).toContain('"reason":"oom"');
      expect(text).toContain('"reason":"clean-exit"');
      expect(text).toContain('"abnormal":false');
      for (const record of records) {
        expect(record.message[1]).toMatchObject({
          windowId: 7,
          webContentsId: 42,
          connectionId: 9,
          rendererPid: 123,
          run: expect.any(String),
          timestamp: expect.any(String),
        });
      }
      expect(native.eventNames()).toEqual([]);
      expect(contents.eventNames()).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("explicit disposal removes listeners before destruction without inventing a crash", () =>
  Effect.sync(() => {
    const contents = Object.assign(new EventEmitter(), { id: 2, getOSProcessId: () => 3 });
    const native = Object.assign(new EventEmitter(), { id: 1, webContents: contents });
    const records: unknown[] = [];
    const dispose = installWindowResponsivenessDiagnostics(
      native as unknown as BrowserWindow,
      4,
      (record) => records.push(record),
    );
    dispose();
    contents.emit("destroyed");
    native.emit("closed");
    expect(records).toEqual([]);
    expect(contents.eventNames()).toEqual([]);
    expect(native.eventNames()).toEqual([]);
  }),
);
