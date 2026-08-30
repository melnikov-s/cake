import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalStore, type TerminalTarget } from "../../../../src/renderer/stores/TerminalStore";

const stores: TerminalStore[] = [];

const projectTarget = (sessionId: string): TerminalTarget => ({
  kind: "project",
  sessionId,
  workspacePath: `/workspace/${sessionId}`,
});

afterEach(() => {
  for (const store of stores.splice(0)) store[Symbol.dispose]();
});

describe("TerminalStore", () => {
  it("lazily retains an independent terminal for each Cake session", async () => {
    let target: TerminalTarget = projectTarget("one");
    const openTerminal = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const closeTerminal = vi.fn(async () => undefined);
    const store = mount(
      createStore(TerminalStore, {
        client: { openTerminal, closeTerminal },
        activeTarget: () => target,
      }),
    );
    stores.push(store);

    expect(openTerminal).not.toHaveBeenCalled();
    await store.toggle();
    const firstTerminalId = store.activeEntry?.terminalId;
    await store.toggle();
    await store.toggle();
    expect(store.activeEntry?.terminalId).toBe(firstTerminalId);

    store.hide();
    target = projectTarget("two");
    await store.toggle();

    expect(store.entries).toHaveLength(2);
    expect(openTerminal).toHaveBeenCalledTimes(2);
    expect(openTerminal).toHaveBeenNthCalledWith(1, {
      target: projectTarget("one"),
      cols: 80,
      rows: 24,
    });
    expect(openTerminal).toHaveBeenNthCalledWith(2, {
      target: projectTarget("two"),
      cols: 80,
      rows: 24,
    });
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("buffers shell output that arrives before the open response", async () => {
    let finishOpen!: (value: { terminalId: string; shell: string }) => void;
    const terminalId = crypto.randomUUID();
    const store = mount(
      createStore(TerminalStore, {
        client: {
          openTerminal: () =>
            new Promise((resolve) => {
              finishOpen = resolve;
            }),
        },
        activeTarget: () => projectTarget("one"),
      }),
    );
    stores.push(store);

    const opening = store.toggle();
    store.receive({ type: "terminal-data", terminalId, data: "prompt> " });
    finishOpen({ terminalId, shell: "zsh" });
    await opening;
    const output: string[] = [];
    store.subscribeData("project:one", (data) => output.push(data));

    expect(output).toEqual(["prompt> "]);
  });

  it("requires confirmation and closes terminals with running programs before resolution", async () => {
    const closeTerminal = vi.fn(async () => undefined);
    const store = mount(
      createStore(TerminalStore, {
        client: {
          openTerminal: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
          getTerminalStatus: async () => ({ runningProgram: true }),
          closeTerminal,
        },
        activeTarget: () => projectTarget("one"),
      }),
    );
    stores.push(store);
    await store.toggle();

    const prepared = store.prepareResolution([{ kind: "project", sessionId: "one" }]);
    await vi.waitFor(() => {
      expect(store.resolutionRequest).toEqual({ runningProgramCount: 1 });
    });
    await store.confirmResolution();

    await expect(prepared).resolves.toBe(true);
    expect(closeTerminal).toHaveBeenCalledOnce();
    expect(store.entries).toHaveLength(0);
  });

  it("resolves without confirmation when the terminal is waiting at its shell prompt", async () => {
    const getTerminalStatus = vi.fn(async () => ({ runningProgram: false }));
    const store = mount(
      createStore(TerminalStore, {
        client: {
          openTerminal: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
          getTerminalStatus,
        },
        activeTarget: () => projectTarget("one"),
      }),
    );
    stores.push(store);
    await store.toggle();

    await expect(store.prepareResolution([{ kind: "project", sessionId: "one" }])).resolves.toBe(
      true,
    );
    expect(getTerminalStatus).toHaveBeenCalledWith(store.activeEntry?.terminalId);
    expect(store.resolutionRequest).toBeUndefined();
  });
});
