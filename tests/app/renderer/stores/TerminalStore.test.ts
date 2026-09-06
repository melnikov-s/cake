import { createStore, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { TerminalStore, type TerminalTarget } from "../../../../src/renderer/stores/TerminalStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const stores: Disposable[] = [];

const workingDirectoryTarget = (
  workingDirectory: string,
  label = workingDirectory,
): TerminalTarget => ({ workingDirectory, label });

function mountTerminal(
  activeTarget: () => TerminalTarget | undefined,
  commands: Partial<RendererClient["terminals"]>,
) {
  const terminals: RendererClient["terminals"] = {
    open: async () => {
      throw new Error("Unexpected terminal open");
    },
    write: async () => undefined,
    resize: async () => undefined,
    workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
    close: async () => undefined,
    closeWorkingDirectory: async () => undefined,
    ...commands,
  };
  const mounted = mountWithRendererClient(
    createStore(TerminalStore, {
      activeTarget,
      toggleAcceleratorHint: () => "Ctrl+`",
      newTabHotkey: () => "Mod+T",
    }),
    {
      terminals,
    } as unknown as RendererClient,
  );
  stores.push(mounted.root);
  return mounted.subject;
}

afterEach(() => {
  for (const store of stores.splice(0)) store[Symbol.dispose]();
});

describe("TerminalStore", () => {
  it("closes a late open response instead of resurrecting a retired tab", async () => {
    let finishOpen!: (value: { terminalId: string; shell: string }) => void;
    const close = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open: () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
      close,
    });
    const opening = store.toggle();
    await store.prepareWorkingDirectoryRetirement(["/workspace/one"]);
    finishOpen({ terminalId: "late-terminal", shell: "zsh" });
    await opening;
    expect(store.entries).toHaveLength(0);
    expect(close).toHaveBeenCalledWith("late-terminal");
  });

  it("does not restore an error tab when a retired open fails", async () => {
    let failOpen!: (error: Error) => void;
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open: () =>
        new Promise((_resolve, reject) => {
          failOpen = reject;
        }),
    });
    const opening = store.toggle();
    await store.prepareWorkingDirectoryRetirement(["/workspace/one"]);
    failOpen(new Error("Directory removed"));
    await opening;
    expect(store.entries).toHaveLength(0);
  });

  it("warns about other windows even when this window has no terminals", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      workingDirectoryStatus: async () => ({ runningProgramCount: 2 }),
      closeWorkingDirectory,
    });
    const retiring = store.prepareWorkingDirectoryRetirement(["/workspace/one"]);
    await vi.waitFor(() => expect(store.resolutionRequest?.runningProgramCount).toBe(2));
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
    store.cancelResolution();
    await expect(retiring).resolves.toBe(false);
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
  });

  it("blocks new tabs and repeated retirement while inspecting or confirming", async () => {
    let finishStatus!: (value: { runningProgramCount: number }) => void;
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open,
      workingDirectoryStatus: () =>
        new Promise((resolve) => {
          finishStatus = resolve;
        }),
    });
    const retiring = store.prepareWorkingDirectoryRetirement(["/workspace/one"]);
    await store.newTab();
    await expect(store.prepareWorkingDirectoryRetirement(["/workspace/one"])).resolves.toBe(false);
    finishStatus({ runningProgramCount: 1 });
    await vi.waitFor(() => expect(store.resolutionRequest).toBeDefined());
    await store.newTab();
    expect(open).not.toHaveBeenCalled();
    store.cancelResolution();
    await retiring;
    await store.newTab();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not close terminals if their status could not be inspected", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      workingDirectoryStatus: async () => {
        throw new Error("Inspection failed");
      },
      closeWorkingDirectory,
    });
    await expect(store.prepareWorkingDirectoryRetirement(["/workspace/one"])).rejects.toThrow(
      "Inspection failed",
    );
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
  });

  it("shares terminals between sessions in one Working Directory and separates worktrees", async () => {
    const activity = observable({
      target: workingDirectoryTarget("/workspace/shared", "Session one"),
    });
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const close = vi.fn(async () => undefined);
    const store = mountTerminal(() => activity.target, { open, close });

    expect(open).not.toHaveBeenCalled();
    await store.toggle();
    const firstTerminalId = store.activeEntry?.terminalId;
    activity.target = workingDirectoryTarget("/workspace/shared", "Session two");
    expect(store.activeEntry?.terminalId).toBe(firstTerminalId);

    activity.target = workingDirectoryTarget("/workspace/other", "Other worktree");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));

    expect(store.open).toBe(true);
    expect(store.entries).toHaveLength(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, {
      target: { workingDirectory: "/workspace/shared" },
      cols: 80,
      rows: 24,
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      target: { workingDirectory: "/workspace/other" },
      cols: 80,
      rows: 24,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("buffers shell output that arrives before the open response", async () => {
    let finishOpen!: (value: { terminalId: string; shell: string }) => void;
    const terminalId = crypto.randomUUID();
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open: () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        }),
    });

    const opening = store.toggle();
    store.receive({ type: "terminal-data", terminalId, data: "prompt> " });
    finishOpen({ terminalId, shell: "zsh" });
    await opening;
    const output: string[] = [];
    store.subscribeData(store.activeEntry!.key, (data) => output.push(data));

    expect(output).toEqual(["prompt> "]);
  });

  it("opens and switches independent tabs for the active Working Directory", async () => {
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), { open });

    await store.toggle();
    const firstKey = store.activeEntry!.key;
    await store.newTab();
    const secondKey = store.activeEntry!.key;

    expect(store.activeEntries).toHaveLength(2);
    expect(secondKey).not.toBe(firstKey);
    expect(open).toHaveBeenCalledTimes(2);
    store.activate(firstKey);
    expect(store.activeEntry?.key).toBe(firstKey);

    store.dock();
    expect(store.docked).toBe(true);
    store.moveToTop();
    expect(store.docked).toBe(false);
  });

  it("requires confirmation and closes terminals before retiring a Working Directory", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
      workingDirectoryStatus: async () => ({ runningProgramCount: 1 }),
      closeWorkingDirectory,
    });
    await store.toggle();

    const prepared = store.prepareWorkingDirectoryRetirement(["/workspace/one"]);
    await vi.waitFor(() => {
      expect(store.resolutionRequest).toEqual({ runningProgramCount: 1 });
    });
    await store.confirmResolution();

    await expect(prepared).resolves.toBe(true);
    expect(closeWorkingDirectory).toHaveBeenCalledWith("/workspace/one");
    expect(store.entries).toHaveLength(0);
  });

  it("retires without confirmation when terminals are waiting at their shell prompts", async () => {
    const workingDirectoryStatus = vi.fn(async () => ({ runningProgramCount: 0 }));
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
      workingDirectoryStatus,
      closeWorkingDirectory,
    });
    await store.toggle();
    await expect(store.prepareWorkingDirectoryRetirement(["/workspace/one"])).resolves.toBe(true);
    expect(workingDirectoryStatus).toHaveBeenCalledWith("/workspace/one");
    expect(closeWorkingDirectory).toHaveBeenCalledWith("/workspace/one");
    expect(store.resolutionRequest).toBeUndefined();
    expect(store.entries).toHaveLength(0);
  });
});
