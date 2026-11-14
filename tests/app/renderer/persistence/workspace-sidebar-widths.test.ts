import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { browserInitialSnapshot } from "../../../../src/renderer/bootstrap/browser-initial-snapshot";
import { migrateWorkspaceSidebarWidths } from "../../../../src/renderer/persistence/migrate-workspace-sidebar-widths";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const modes = ["normal", "vscode", "browser"] as const;
const snapshot = (state: StoreSnapshot["state"]): StoreSnapshot => ({
  state: {},
  children: { workspaceNavigatorStore: { state, children: {} } },
});

describe("per-presentation sidebar preferences", () => {
  it("defaults all three preferences to 320", () => {
    using f = createRendererStoreFixture();
    expect(modes.map((mode) => f.root.workspaceNavigatorStore.widthFor(mode))).toEqual([
      320, 320, 320,
    ]);
  });

  it("routes editor and browser callbacks to their own widths, even while inactive", () => {
    using f = createRendererStoreFixture();
    const navigator = f.root.workspaceNavigatorStore;
    const presentation = f.root.projectWorkbenchStore.presentationStore;
    navigator.setWidth("normal", 380);
    presentation.embeddedEditorStore.setChatSidebarWidth(620);
    presentation.browserStore.setChatSidebarWidth(480);
    expect(navigator.chatWidth).toBe(380);
    expect(presentation.embeddedEditorStore.chatSidebarWidth).toBe(620);
    expect(presentation.browserStore.chatSidebarWidth).toBe(480);
    expect(f.root.workspaceSession?.presentationMode).toBe("normal");
  });

  it("persists and hydrates all three preferences without the former shared field", () => {
    using f = createRendererStoreFixture();
    const navigator = f.root.workspaceNavigatorStore;
    navigator.setWidth("normal", 380);
    navigator.setWidth("vscode", 620);
    navigator.setWidth("browser", 480);
    const saved = JSON.parse(JSON.stringify(toSnapshot(f.root))) as StoreSnapshot;
    expect(saved.children.workspaceNavigatorStore).toMatchObject({
      state: { chatWidth: 380, vscodeWidth: 620, browserWidth: 480 },
    });
    expect(saved.children.workspaceNavigatorStore).not.toHaveProperty("state.width");
    using restored = createRendererStoreFixture({ snapshot: saved });
    const hydrated = restored.root.workspaceNavigatorStore;
    expect(modes.map((mode) => hydrated.widthFor(mode))).toEqual([380, 620, 480]);
    hydrated.setWidth("browser", 720);
    expect(modes.map((mode) => hydrated.widthFor(mode))).toEqual([380, 620, 720]);
  });

  it.each(modes)("enforces the minimum only for the resized %s preference", (mode) => {
    using f = createRendererStoreFixture();
    const navigator = f.root.workspaceNavigatorStore;
    navigator.setWidth(mode, 100);
    for (const other of modes) {
      expect(navigator.widthFor(other)).toBe(other === mode ? 240 : 320);
    }
  });

  it("hydrates a legacy shared width into all three preferences before any resize", () => {
    const saved = snapshot({ width: 512, companionTab: "sessions", accessoryVisible: false });
    const before = structuredClone(saved);
    using f = createRendererStoreFixture({ snapshot: saved });
    const navigator = f.root.workspaceNavigatorStore;
    expect(modes.map((mode) => navigator.widthFor(mode))).toEqual([512, 512, 512]);
    expect(navigator.companionTab).toBe("sessions");
    navigator.setWidth("normal", 400);
    expect(modes.map((mode) => navigator.widthFor(mode))).toEqual([400, 512, 512]);
    expect(saved).toEqual(before);
  });

  it.each([false, true])("migrates browser-host snapshots too (phone: %s)", (phone) => {
    const migrated = browserInitialSnapshot(snapshot({ width: 416 }), phone);
    expect(migrated.children.workspaceNavigatorStore).toMatchObject({
      state: { chatWidth: 416, vscodeWidth: 416, browserWidth: 416 },
    });
    expect(migrated.children.workspaceNavigatorStore).not.toHaveProperty("state.width");
  });

  it("keeps existing per-mode widths and unrelated state; migration is immutable and idempotent", () => {
    const saved = snapshot({
      width: 512,
      chatWidth: 400,
      browserWidth: 680,
      accessoryVisible: false,
      mode: "sessions",
      companionTab: "todos",
    });
    const before = structuredClone(saved);
    const migrated = migrateWorkspaceSidebarWidths(saved);
    expect(migrated.children.workspaceNavigatorStore).toEqual({
      state: {
        chatWidth: 400,
        vscodeWidth: 512,
        browserWidth: 680,
        accessoryVisible: false,
        mode: "sessions",
        companionTab: "todos",
      },
      children: {},
    });
    expect(saved).toEqual(before);
    expect(migrateWorkspaceSidebarWidths(migrated)).toBe(migrated);
  });
});
