import { createStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { TerminalStore, type TerminalTarget } from "../../../../src/renderer/stores/TerminalStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const stores: Disposable[] = [];

const projectTarget = (sessionId: string): TerminalTarget => ({
  kind: "project",
  sessionId,
  workspacePath: `/workspace/${sessionId}`,
});

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
    status: async () => ({ runningProgram: false }),
    close: async () => undefined,
    ...commands,
  };
  const mounted = mountWithRendererClient(createStore(TerminalStore, { activeTarget }), {
    terminals,
  } as unknown as RendererClient);
  stores.push(mounted.root);
  return mounted.subject;
}

afterEach(() => {
  for (const store of stores.splice(0)) store[Symbol.dispose]();
});

describe("TerminalStore", () => {
  it("lazily retains an independent terminal for each Cake session", async () => {
    let target: TerminalTarget = projectTarget("one");
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const close = vi.fn(async () => undefined);
    const store = mountTerminal(() => target, { open, close });

    expect(open).not.toHaveBeenCalled();
    await store.toggle();
    const firstTerminalId = store.activeEntry?.terminalId;
    await store.toggle();
    await store.toggle();
    expect(store.activeEntry?.terminalId).toBe(firstTerminalId);

    store.hide();
    target = projectTarget("two");
    await store.toggle();

    expect(store.entries).toHaveLength(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, {
      target: projectTarget("one"),
      cols: 80,
      rows: 24,
    });
    expect(open).toHaveBeenNthCalledWith(2, {
      target: projectTarget("two"),
      cols: 80,
      rows: 24,
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("buffers shell output that arrives before the open response", async () => {
    let finishOpen!: (value: { terminalId: string; shell: string }) => void;
    const terminalId = crypto.randomUUID();
    const store = mountTerminal(() => projectTarget("one"), {
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

  it("opens and switches independent tabs for the active session", async () => {
    const open = vi.fn(async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }));
    const store = mountTerminal(() => projectTarget("one"), { open });

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

  it("requires confirmation and closes terminals with running programs before resolution", async () => {
    const close = vi.fn(async () => undefined);
    const store = mountTerminal(() => projectTarget("one"), {
      open: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
      status: async () => ({ runningProgram: true }),
      close,
    });
    await store.toggle();

    const prepared = store.prepareResolution([{ kind: "project", sessionId: "one" }]);
    await vi.waitFor(() => {
      expect(store.resolutionRequest).toEqual({ runningProgramCount: 1 });
    });
    await store.confirmResolution();

    await expect(prepared).resolves.toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(store.entries).toHaveLength(0);
  });

  it("resolves without confirmation when the terminal is waiting at its shell prompt", async () => {
    const status = vi.fn(async () => ({ runningProgram: false }));
    const store = mountTerminal(() => projectTarget("one"), {
      open: async () => ({ terminalId: crypto.randomUUID(), shell: "zsh" }),
      status,
    });
    await store.toggle();

    await expect(store.prepareResolution([{ kind: "project", sessionId: "one" }])).resolves.toBe(
      true,
    );
    expect(status).toHaveBeenCalledWith(store.activeEntry?.terminalId);
    expect(store.resolutionRequest).toBeUndefined();
  });
});
