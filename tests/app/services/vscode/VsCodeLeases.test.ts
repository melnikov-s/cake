import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  VsCodeServerRuntime,
  type ServerInstance,
} from "../../../../src/services/vscode/VsCodeServerRuntime";

// The backend implementation must import and operate in ordinary Node, without a native adapter.
vi.mock("electron", () => {
  throw new Error("Backend imported Electron");
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cake-vscode-lease-")));
  roots.push(root);
  const binary = join(root, "code-server");
  await writeFile(binary, "#!/bin/sh\n");
  await chmod(binary, 0o755);
  const sendTo = vi.fn();
  const scheduleIdleEviction = vi.fn();
  const cancelIdleEviction = vi.fn();
  const runtime = new VsCodeServerRuntime({
    root,
    companionManifest: {
      name: "cake-companion",
      displayName: "Cake",
      description: "",
      version: "0.0.0",
      publisher: "cake",
      private: true,
      license: "UNLICENSED",
      engines: { vscode: "*" },
      main: "extension.js",
      activationEvents: [],
      contributes: { commands: [] },
    },
    companionSource: "",
    companionThemes: [],
    customPath: () => binary,
    sendTo,
    stateChanged: () => {},
    scheduleIdleEviction,
    cancelIdleEviction,
    invalidateServer: () => {},
    evictServer: async () => {},
    pollUntil: async (_key, check, _interval, _timeout, failure) => {
      const value = check();
      if (value === undefined) throw new Error(failure);
      return value;
    },
    acquireServer: async () => {
      throw new Error("Expected seeded external process");
    },
  });
  const instance: ServerInstance = {
    workspacePath: root,
    binary,
    child: { kill: vi.fn(), removeAllListeners: vi.fn() } as never,
    port: 4321,
    flavor: "codeserver",
    token: "token",
    viewers: 0,
    lastUsedAt: 0,
  };
  runtime["servers"].set(root, instance);
  runtime["themes"].set(root, "dark");
  return { root, runtime, instance, sendTo, scheduleIdleEviction, cancelIdleEviction };
}

it("leases a workspace exclusively to its logical desktop owner and releases only that owner", async () => {
  const { root, runtime, instance, scheduleIdleEviction, cancelIdleEviction } = await fixture();
  const lease = await runtime.acquire(101, root, "dark");
  expect(lease.connectionId).toBe(101);
  expect(lease.url).toBe("http://127.0.0.1:4321/");
  expect(instance.viewers).toBe(1);
  expect(cancelIdleEviction).toHaveBeenCalled();
  await expect(runtime.acquire(202, root, "dark")).rejects.toThrow(
    "already open in another desktop",
  );
  expect(await runtime.acquire(101, root, "dark")).toBe(lease);
  expect(instance.viewers).toBe(1);
  runtime.setVisible(101, true);
  expect(await runtime.isVisible(root)).toBe(true);
  runtime.releaseConnection(202);
  expect(lease.revocation.signal.aborted).toBe(false);
  expect(await runtime.isVisible(root)).toBe(true);
  expect(instance.viewers).toBe(1);
  runtime.releaseConnection(101);
  expect(lease.revocation.signal.aborted).toBe(true);
  expect(await runtime.isVisible(root)).toBe(false);
  expect(instance.viewers).toBe(0);
  expect(scheduleIdleEviction).toHaveBeenCalledOnce();
  const reopened = await runtime.acquire(202, root, "dark");
  expect(reopened.id).not.toBe(lease.id);
  runtime.releaseLease(202, lease.id);
  expect(runtime.leaseFor(202)).toBe(reopened);
  expect(reopened.revocation.signal.aborted).toBe(false);
  expect(instance.viewers).toBe(1);
  runtime.disposeAll();
  expect(reopened.revocation.signal.aborted).toBe(true);
});

it("reopens a retained server with a different theme without waiting for its disconnected companion", async () => {
  const { root, runtime, instance } = await fixture();
  await runtime.acquire(101, root, "dark");
  runtime["companionPorts"].set(root, 4567);
  runtime.releaseConnection(101);
  expect(runtime["companionPorts"].has(root)).toBe(false);
  const lease = await runtime.acquire(202, root, "light");
  expect(lease.connectionId).toBe(202);
  expect(runtime["themes"].get(root)).toBe("light");
  expect(runtime["servers"].get(root)).toBe(instance);
  runtime.disposeAll();
});

it("replaces an idle local openvscode process before leasing the workspace to a remote code-server viewer", async () => {
  const { root, runtime, instance } = await fixture();
  instance.binary = join(root, "openvscode-server");
  instance.flavor = "openvscode";
  const replacement: ServerInstance = {
    ...instance,
    binary: join(root, "code-server"),
    flavor: "codeserver",
    port: 4322,
  };
  const evict = vi.fn(async () => runtime.releaseServer(instance));
  const acquire = vi.fn(async () => {
    runtime["servers"].set(root, replacement);
    return replacement;
  });
  runtime["props"].evictServer = evict;
  runtime["props"].acquireServer = acquire;

  const lease = await runtime.acquire(202, root, "dark", undefined, true);
  expect(evict).toHaveBeenCalledWith(`${root}\0${instance.binary}`);
  expect(acquire).toHaveBeenCalledWith(root, replacement.binary, undefined);
  expect(lease.flavor).toBe("codeserver");
  expect(lease.url).toBe("http://127.0.0.1:4322/");
  runtime.disposeAll();
});

it("routes companion selections and annotations only to the lease owner, never observers", async () => {
  const { root, runtime, sendTo } = await fixture();
  await runtime.acquire(101, root, "dark");
  const message = {
    type: "ask-in-side-chat",
    workspace: root,
    path: "file.ts",
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 3,
    selectedText: "abc",
    contextBefore: "",
    contextAfter: "",
  };
  runtime["handleBridgeMessage"](Buffer.from(JSON.stringify(message)));
  expect(sendTo).toHaveBeenCalledWith(
    101,
    expect.objectContaining({
      type: "embedded-editor-side-chat-requested",
      path: "file.ts",
      workspacePath: root,
    }),
  );
  runtime.releaseConnection(101);
  sendTo.mockClear();
  runtime["handleBridgeMessage"](Buffer.from(JSON.stringify(message)));
  expect(sendTo).not.toHaveBeenCalled();
  await runtime.acquire(202, root, "dark");
  runtime["handleBridgeMessage"](Buffer.from(JSON.stringify(message)));
  expect(sendTo).toHaveBeenCalledWith(
    202,
    expect.objectContaining({ type: "embedded-editor-side-chat-requested" }),
  );
  runtime.disposeAll();
});
