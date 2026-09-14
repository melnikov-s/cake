import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VsCodeServerRuntime,
  type CompanionManifest,
  type ServerInstance,
} from "../../../../src/services/vscode/VsCodeServerRuntime";

interface FakeView {
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
  };
}

const fakeElectron = vi.hoisted(() => {
  const views: FakeView[] = [];
  let loadURL: () => Promise<void> = async () => undefined;
  return {
    views,
    setLoadURL(next: () => Promise<void>) {
      loadURL = next;
    },
    WebContentsView: class {
      setBackgroundColor = vi.fn();
      setVisible = vi.fn();
      setBounds = vi.fn();
      webContents = {
        on: vi.fn(),
        loadURL: vi.fn(() => loadURL()),
        executeJavaScript: vi.fn(async () => undefined),
      };
      constructor() {
        views.push(this);
      }
    },
  };
});

vi.mock("electron", () => ({
  WebContentsView: fakeElectron.WebContentsView,
  BrowserWindow: { getAllWindows: () => [] },
}));

const companionManifest: CompanionManifest = {
  name: "cake-companion",
  displayName: "Cake Companion",
  description: "Test companion",
  version: "0.0.0",
  publisher: "cake",
  private: true,
  license: "UNLICENSED",
  engines: { vscode: "*" },
  main: "./extension.js",
  activationEvents: [],
  contributes: { commands: [] },
};

const shownBounds = {
  visible: true,
  x: 292,
  y: 0,
  width: 480,
  height: 820,
  projectSidebarWidth: 292,
};
const hiddenBounds = { ...shownBounds, visible: false };
const unmountedBounds = {
  visible: false,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  projectSidebarWidth: 292,
};

async function createFixture(options?: { preferredTheme?: () => Promise<"light" | "dark"> }) {
  const root = await mkdtemp(join(tmpdir(), "cake-vscode-views-"));
  const binary = join(root, "code-server");
  await writeFile(binary, "#!/bin/sh\n");
  await chmod(binary, 0o755);
  const workspace = join(root, "project");
  await mkdir(workspace);
  const resolvedWorkspace = await realpath(workspace);
  const runtime = new VsCodeServerRuntime({
    root,
    companionManifest,
    companionMain: "/unused/companion.js",
    companionThemes: [],
    customPath: () => binary,
    preferredTheme: options?.preferredTheme ?? (async () => "dark" as const),
    broadcast: () => undefined,
    stateChanged: () => undefined,
    scheduleIdleEviction: () => undefined,
    cancelIdleEviction: () => undefined,
    invalidateServer: () => undefined,
    evictServer: async () => undefined,
    pollUntil: async (_key, check, _interval, _timeout, failure) => {
      const value = check();
      if (value !== undefined) return value;
      throw new Error(failure);
    },
    acquireServer: () => {
      throw new Error("The test seeds a running server");
    },
  });
  const instance: ServerInstance = {
    workspacePath: resolvedWorkspace,
    child: new EventEmitter() as never,
    port: 4321,
    token: "token",
    flavor: "codeserver",
    binary,
    lastUsedAt: 0,
    viewers: 0,
  };
  runtime["servers"].set(resolvedWorkspace, instance);
  const window = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  return { root, runtime, workspace, instance, window };
}

describe("VsCodeServerRuntime native views", () => {
  let root: string | undefined;

  afterEach(async () => {
    fakeElectron.views.length = 0;
    fakeElectron.setLoadURL(async () => undefined);
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("runs concurrent opens for one window sequentially so it owns a single view", async () => {
    // Theme resolution yields a macrotask between the reuse check and view creation,
    // the same window an in-flight server start opens in the application.
    const fixture = await createFixture({
      preferredTheme: () => new Promise((resolve) => setTimeout(() => resolve("dark"), 10)),
    });
    root = fixture.root;
    let finishLoad!: () => void;
    fakeElectron.setLoadURL(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    );

    // Both opens start before either has resolved the binary or registered a view,
    // as when a user click and a session restore race on startup.
    const first = fixture.runtime.open(7, () => fixture.window as never, fixture.workspace);
    const second = fixture.runtime.open(7, () => fixture.window as never, fixture.workspace);
    await vi.waitFor(() => expect(fakeElectron.views).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fakeElectron.views).toHaveLength(1);

    finishLoad();
    await Promise.all([first, second]);

    expect(fakeElectron.views).toHaveLength(1);
    expect(fixture.window.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(fixture.runtime["views"].size).toBe(1);
    expect(fixture.instance.viewers).toBe(1);
  });

  it("loads the workbench hidden at its final size and shows it without resizing", async () => {
    const fixture = await createFixture();
    root = fixture.root;
    fixture.runtime.updateBounds(7, hiddenBounds);

    await fixture.runtime.open(7, () => fixture.window as never, fixture.workspace);
    const [view] = fakeElectron.views;
    expect(view).toBeDefined();
    expect(view!.setVisible).toHaveBeenLastCalledWith(false);
    expect(view!.setBounds).toHaveBeenLastCalledWith({ x: 292, y: 0, width: 480, height: 820 });
    expect(view!.setBounds).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });

    fixture.runtime.updateBounds(7, shownBounds);
    expect(view!.setVisible).toHaveBeenLastCalledWith(true);
    expect(view!.setBounds).toHaveBeenLastCalledWith({ x: 292, y: 0, width: 480, height: 820 });
  });

  it("keeps the last geometry when the surface unmounts and flips visibility on return", async () => {
    const fixture = await createFixture();
    root = fixture.root;
    fixture.runtime.updateBounds(7, shownBounds);
    await fixture.runtime.open(7, () => fixture.window as never, fixture.workspace);
    const [view] = fakeElectron.views;
    view!.setBounds.mockClear();

    fixture.runtime.updateBounds(7, unmountedBounds);
    expect(view!.setVisible).toHaveBeenLastCalledWith(false);
    expect(view!.setBounds).not.toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });
    expect(fixture.runtime["requestedBounds"].get(7)).toEqual(hiddenBounds);

    fixture.runtime.updateBounds(7, shownBounds);
    expect(view!.setVisible).toHaveBeenLastCalledWith(true);
    expect(view!.setBounds).toHaveBeenLastCalledWith({ x: 292, y: 0, width: 480, height: 820 });
  });

  it("never draws a view for a window that has not reported a surface yet", async () => {
    const fixture = await createFixture();
    root = fixture.root;

    await fixture.runtime.open(7, () => fixture.window as never, fixture.workspace);
    const [view] = fakeElectron.views;

    expect(view!.setVisible).toHaveBeenLastCalledWith(false);
    expect(view!.setBounds).not.toHaveBeenCalled();
  });
});
