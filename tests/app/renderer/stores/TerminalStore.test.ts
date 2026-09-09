import { createStore, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { TerminalStore, type TerminalTarget } from "../../../../src/renderer/stores/TerminalStore";
import { WorkingDirectoryRetirementStore } from "../../../../src/renderer/stores/WorkingDirectoryRetirementStore";
import { mountWithClient } from "../mount-with-client";

const stores: Disposable[] = [];
const retirements = new WeakMap<TerminalStore, WorkingDirectoryRetirementStore>();

const workingDirectoryTarget = (
  workingDirectory: string,
  label = workingDirectory,
): TerminalTarget => ({ workingDirectory, label });

function mountTerminal(
  activeTarget: () => TerminalTarget | undefined,
  commands: Partial<Client["terminals"]>,
) {
  const terminals: Client["terminals"] = {
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
  const client = { terminals } as unknown as Client;
  const terminalRef: { current?: TerminalStore } = {};
  const retirementMount = mountWithClient(
    createStore(WorkingDirectoryRetirementStore, {
      onRetired: (workingDirectories) =>
        terminalRef.current!.releaseWorkingDirectories(workingDirectories),
    }),
    client,
  );
  const mounted = mountWithClient(
    createStore(TerminalStore, {
      activeTarget,
      retirement: () => retirementMount.subject,
      toggleAcceleratorHint: () => "Ctrl+`",
      newTabHotkey: () => "Mod+T",
    }),
    client,
  );
  terminalRef.current = mounted.subject;
  retirements.set(mounted.subject, retirementMount.subject);
  stores.push(mounted.root, retirementMount.root);
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
    await retirements.get(store)!.prepare(["/workspace/one"]);
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
    await retirements.get(store)!.prepare(["/workspace/one"]);
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
    const retiring = retirements.get(store)!.prepare(["/workspace/one"]);
    await vi.waitFor(() =>
      expect(retirements.get(store)!.confirmationRequest?.runningProgramCount).toBe(2),
    );
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
    retirements.get(store)!.cancel();
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
    const retiring = retirements.get(store)!.prepare(["/workspace/one"]);
    await store.newTab();
    await expect(retirements.get(store)!.prepare(["/workspace/one"])).resolves.toBe(false);
    finishStatus({ runningProgramCount: 1 });
    await vi.waitFor(() => expect(retirements.get(store)!.confirmationRequest).toBeDefined());
    await store.newTab();
    expect(open).not.toHaveBeenCalled();
    retirements.get(store)!.cancel();
    await retiring;
    await store.newTab();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("blocks new tabs until prompt-only terminals finish closing", async () => {
    let finishClose!: () => void;
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const closeWorkingDirectory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      open,
      workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
      closeWorkingDirectory,
    });

    const retiring = retirements.get(store)!.prepare(["/workspace/one"]);
    await vi.waitFor(() => expect(closeWorkingDirectory).toHaveBeenCalledOnce());
    await store.newTab();
    expect(open).not.toHaveBeenCalled();

    finishClose();
    await expect(retiring).resolves.toBe(true);
    await store.newTab();
    expect(open).toHaveBeenCalledOnce();
  });

  it("does not close terminals if their status could not be inspected", async () => {
    const closeWorkingDirectory = vi.fn(async () => undefined);
    const store = mountTerminal(() => workingDirectoryTarget("/workspace/one"), {
      workingDirectoryStatus: async () => {
        throw new Error("Inspection failed");
      },
      closeWorkingDirectory,
    });
    await expect(retirements.get(store)!.prepare(["/workspace/one"])).rejects.toThrow(
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

    const prepared = retirements.get(store)!.prepare(["/workspace/one"]);
    await vi.waitFor(() => {
      expect(retirements.get(store)!.confirmationRequest).toEqual({ runningProgramCount: 1 });
    });
    await retirements.get(store)!.confirm();

    await expect(prepared).resolves.toBe(true);
    expect(closeWorkingDirectory).toHaveBeenCalledWith("/workspace/one", expect.any(Object));
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
    await expect(retirements.get(store)!.prepare(["/workspace/one"])).resolves.toBe(true);
    expect(workingDirectoryStatus).toHaveBeenCalledWith("/workspace/one", expect.any(Object));
    expect(closeWorkingDirectory).toHaveBeenCalledWith("/workspace/one", expect.any(Object));
    expect(retirements.get(store)!.confirmationRequest).toBeUndefined();
    expect(store.entries).toHaveLength(0);
  });
});
