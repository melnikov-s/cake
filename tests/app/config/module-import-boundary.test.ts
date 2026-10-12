import { ESLint } from "eslint";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const eslint = new ESLint();
const ruleId = "architecture/module-boundaries";
const piFile = "src/services/pi/import-boundary-fixture.ts";
const storageFile = "src/services/storage/import-boundary-fixture.ts";
const rendererFile = "src/renderer/stores/ImportBoundaryFixtureStore.ts";

// Load the real configuration: these tests also catch flat-config overrides
// accidentally replacing architecture enforcement on a more specific surface.
beforeAll(async () => {
  await eslint.calculateConfigForFile(piFile);
  await eslint.calculateConfigForFile(rendererFile);
}, 30_000);

async function violations(code: string, filePath: string) {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((result) => result.messages);
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return messages.filter((message) => message.ruleId === ruleId);
}

function valueImport(source: string) {
  return `import { value } from ${JSON.stringify(source)}; export { value };`;
}

describe("Service dependency direction", () => {
  it.each([
    'import { operation } from "../../domain/example"; export { operation };',
    'import type { Value } from "../../domain/example"; export type { Value };',
    'export { operation } from "../../domain/example";',
    'export type { Value } from "../../domain/example";',
    'export * from "../../domain/example";',
    'export * as policy from "../../domain/example";',
    'const policy = import("../../domain/example"); export { policy };',
    "const policy = import(`../../domain/example`); export { policy };",
    'type Value = import("../../domain/example").Value; export type { Value };',
    'import policy = require("../../domain/example"); export { policy };',
    'const policy = require("../../domain/example"); export { policy };',
    'import { wire } from "../../layers/example"; export { wire };',
    'import { wire } from "../pi/../../layers/example"; export { wire };',
    'import { wire } from "src/domain/example"; export { wire };',
    'export * from "../../domain";',
  ])("rejects reverse dependency: %s", async (code) => {
    expect(await violations(code, piFile)).toHaveLength(1);
    expect(await violations(code, storageFile)).toHaveLength(1);
  });

  it.each([
    "@/stores/RootStore",
    "../../main/main",
    "../../ipc/server/CakeRpcServer",
    "../../ipc/protocol/WorkspaceRpc",
    "../../ipc/fixture",
    "../../backend/BackendLive",
  ])("rejects upper-layer dependency: %s", async (source) => {
    expect(await violations(valueImport(source), piFile)).toHaveLength(1);
  });

  it.each([
    "../../contracts/pi/model-data",
    "../../contracts/conversations/session-contract",
    "../storage/example",
    "../../config/CakePaths",
  ])("permits capability or value dependency: %s", async (source) => {
    expect(await violations(valueImport(source), piFile)).toHaveLength(0);
  });
});

describe("Process and shared-contract boundaries", () => {
  it.each([
    [rendererFile, "../../services/pi/PiSettings"],
    [rendererFile, "../../domain/application/application"],
    [rendererFile, "../../main/main"],
    [rendererFile, "../../preload/preload"],
    [rendererFile, "../../backend/BackendLive"],
    [rendererFile, "../../ipc/server/CakeRpcServer"],
    [rendererFile, "../../ipc/transport/ElectronRpcServerProtocol"],
    [rendererFile, "../../ipc/transport/StandaloneSocketProtocol"],
    [rendererFile, "../../ipc/transport/ElectronRpcServerProtocol.ts?raw"],
    [rendererFile, "../../ipc/transport/FutureServerProtocol"],
    [rendererFile, "../../services"],
    ["src/main/main.ts", "../renderer/stores/RootStore"],
    ["src/domain/projects/projects.ts", "@/stores/RootStore"],
    ["src/domain/projects/projects.ts", "../../ipc/protocol/WorkspaceRpc"],
    ["src/contracts/projects/fixture.ts", "../../services/storage/ApplicationStorage"],
    ["src/contracts/projects/fixture.ts", "../../domain/projects/project-error"],
    ["src/contracts/projects/fixture.ts", "@/models/Project"],
    ["src/contracts/projects/fixture.ts", "../../ipc/protocol/WorkspaceRpc"],
    ["src/utils/fixture.ts", "../domain/projects/project-error"],
    ["src/ipc/protocol/FixtureRpc.ts", "../../services/vscode/VsCodeServer"],
    ["src/ipc/client/fixture.ts", "../../domain/projects/projects"],
    ["src/domain/projects/projects.ts", "../../ipc/fixture"],
    ["src/contracts/projects/fixture.ts", "../../ipc/fixture"],
    ["src/preload/preload.ts", "../renderer/runtime"],
    ["src/preload/preload.ts", "../services/electron/Electron"],
    ["src/config/fixture.ts", "../services/pi/PiPaths"],
  ])("rejects %s → %s, including type-only imports", async (file, source) => {
    expect(await violations(valueImport(source), file)).toHaveLength(1);
    expect(
      await violations(
        `import type { Value } from ${JSON.stringify(source)}; export type { Value };`,
        file,
      ),
    ).toHaveLength(1);
  });

  it("normalizes absolute paths and alias escapes", async () => {
    expect(
      await violations(valueImport(resolve("src/domain/projects/projects.ts")), rendererFile),
    ).toHaveLength(1);
    expect(await violations(valueImport("@/../services/pi/PiSettings"), rendererFile)).toHaveLength(
      1,
    );
  });

  it.each([
    [rendererFile, "../../contracts/pi/model-data"],
    ["src/renderer/runtime.ts", "../ipc/client/CakeIpcClient"],
    ["src/renderer/runtime.ts", "../ipc/transport/ElectronRpcClientProtocol"],
    ["src/ipc/client/fixture.ts", "../protocol/WorkspaceRpc"],
    ["src/ipc/protocol/FixtureRpc.ts", "../../contracts/projects/project-error"],
    ["src/ipc/server/FixtureHandlers.ts", "../../domain/projects/projects"],
    ["src/ipc/server/FixtureHandlers.ts", "../../services/pi/PiSettings"],
    ["src/layers/FixtureLive.ts", "../domain/projects/projects"],
    ["src/layers/FixtureLive.ts", "../services/pi/PiSettings"],
    ["src/layers/FixtureLive.ts", "../server/NetworkListener"],
    ["src/domain/projects/fixture.ts", "../../services/storage/ApplicationStorage"],
    ["src/contracts/projects/fixture.ts", "../conversations/session-contract"],
    ["src/preload/preload.ts", "../ipc/transport/ElectronRpcTransport"],
    ["src/preload/preload.ts", "electron"],
    ["src/main/main.ts", "node:fs"],
  ])("permits %s → %s", async (file, source) => {
    expect(await violations(valueImport(source), file)).toHaveLength(0);
  });

  it.each([
    "node:fs",
    "fs",
    "fs/promises",
    "electron",
    "electron/renderer",
    "@effect/platform-node-shared",
  ])(
    "blocks privileged package %s in renderer, clients, protocols and shared modules",
    async (source) => {
      for (const file of [
        rendererFile,
        "src/ipc/client/fixture.ts",
        "src/ipc/protocol/FixtureRpc.ts",
        "src/contracts/fixture.ts",
        "src/utils/fixture.ts",
      ])
        expect(await violations(valueImport(source), file)).toHaveLength(1);
    },
  );
});

describe("IPC source organization", () => {
  it.each(["src/ipc/fixture.ts", "src/ipc/data/fixture.ts"])(
    "rejects modules outside protocol, client, server, and transport: %s",
    async (file) => {
      const messages = await violations("export const value = 1;", file);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.messageId).toBe("ipcLocation");
    },
  );

  it.each(["protocol", "client", "server", "transport"])(
    "permits IPC infrastructure in %s",
    async (folder) => {
      expect(await violations("export const value = 1;", `src/ipc/${folder}/fixture.ts`)).toEqual(
        [],
      );
    },
  );
});

describe("Pi SDK authority", () => {
  it.each([
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-durable",
    "@earendil-works/pi-durable-ai",
    "@earendil-works/chord",
    "@earendil-works/pi-ai/submodule",
  ])("restricts %s to Pi adapters even under renderer-specific overrides", async (source) => {
    const code = valueImport(source);
    expect(await violations(code, piFile)).toHaveLength(0);
    expect(await violations(code, "src/services/pi-durable/fixture.ts")).toHaveLength(0);
    expect(await violations(code, storageFile)).toHaveLength(1);
    expect(await violations(code, rendererFile)).toHaveLength(1);
    expect(await violations(code, "src/contracts/fixture.ts")).toHaveLength(1);
  });
});
