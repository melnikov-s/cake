import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  WidgetPackageName,
  WidgetPackageSpecifier,
} from "../../../src/contracts/widgets/widget-packages";
import { createCakeWidgetPackageOperations } from "../../../src/domain/application/cake-widget-package-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

describe("Widget package operations", () => {
  it.each(["d3", "vis-network@9.1.9", "@excalidraw/excalidraw@0.18.1", "d3@^7.0.0", "d3@latest"])(
    "accepts registry specifier %s",
    (value) => {
      expect(Schema.decodeUnknownSync(WidgetPackageSpecifier)(value)).toBe(value);
    },
  );
  it.each([
    "../package",
    "/tmp/package",
    "file:package",
    "https://host/package.tgz",
    "git+https://host/repo",
    "--prefix=/tmp",
    "alias@npm:d3",
    "react",
    "react@19",
    "react-dom",
    "react-dom@19",
  ])("rejects unsafe or reserved specifier %s", (value) => {
    expect(() => Schema.decodeUnknownSync(WidgetPackageSpecifier)(value)).toThrow();
  });
  it.each(["d3@7", "../d3", "--force", "react", "react-dom"])(
    "rejects invalid remove name %s",
    (value) => {
      expect(() => Schema.decodeUnknownSync(WidgetPackageName)(value)).toThrow();
    },
  );
  it("requires real user approval and dispatches typed list/install/remove Settings operations", async () => {
    const snapshot = {
      directory: "/backend/widget-packages",
      items: [{ name: "d3", version: "7.9.0" }],
      total: 1,
      offset: 0,
      nextOffset: null,
    };
    const invoke = vi.fn(async (command: string): Promise<Schema.Json> => ({
      ok: true,
      command,
      value:
        command === "settings.widgets.list"
          ? snapshot
          : command === "settings.widgets.install"
            ? { installed: true, specifier: "d3" }
            : { removed: true, name: "d3" },
    }));
    const registry = new CakeOperationRegistry(createCakeWidgetPackageOperations(invoke));
    const signal = new AbortController().signal;
    const context = { signal, toolCallId: "package-test", runtime: {} };
    await expect(
      registry.invoke({ command: "settings.widgets.install", input: { specifier: "d3" } }, context),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        { command: "settings.widgets.install", input: { specifier: "d3", userApproved: false } },
        context,
      ),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    for (const [command, input] of [
      ["settings.widgets.list", {}],
      ["settings.widgets.install", { specifier: "d3", userApproved: true }],
      ["settings.widgets.remove", { name: "d3" }],
    ] as const) {
      await registry.invoke({ command, input }, context);
      expect(invoke).toHaveBeenLastCalledWith(command, input, signal);
    }
    expect(registry.operationHelp("settings.widgets.install")).toContain("Otherwise ask first");
  });
});
