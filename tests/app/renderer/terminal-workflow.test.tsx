/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { isMacPlatform } from "../../../src/renderer/lib/platform";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

type OpenedTerminal = Awaited<ReturnType<Client["terminals"]["open"]>>;
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderTerminal({
  terminals = {},
  eventsReady = true,
  landedWorktree = false,
  resolveWorkingDirectory,
}: {
  terminals?: Partial<Client["terminals"]>;
  eventsReady?: boolean;
  landedWorktree?: boolean;
  resolveWorkingDirectory?: Client["projectSessions"]["resolveWorkingDirectory"];
} = {}) {
  let nextTerminal = 0;
  const open = vi.fn<Client["terminals"]["open"]>(
    terminals.open ?? (async () => ({ terminalId: `terminal-${++nextTerminal}`, shell: "zsh" })),
  );
  const close = vi.fn<Client["terminals"]["close"]>(terminals.close ?? (async () => undefined));
  const sessions = [
    sessionSummary({
      sessionId: "one",
      title: "First task",
      projectPath: "/project",
      projectName: "Project",
    }),
    sessionSummary({
      sessionId: "two",
      title: "Second task",
      projectPath: "/project",
      projectName: "Project",
    }),
    sessionSummary({
      sessionId: "other",
      title: "Other checkout",
      projectPath: "/project",
      projectName: "Project",
      workingDirectory: "/worktree",
    }),
  ];
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions,
    client: {
      terminals: { ...terminals, open, close },
      projectSessions: {
        open: async () => undefined,
        resolveWorkingDirectory:
          resolveWorkingDirectory ??
          (async ({ workingDirectory }) => ({
            projectPath: "/project",
            workingDirectory,
            resolvedSessionIds: ["other"],
            failures: [],
          })),
      },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  for (const session of sessions) {
    fixture.root.sessionRegistry.load(session.sessionId, session.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(session.sessionId, session.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: session.sessionId,
          sessionFile: `/sessions/${session.sessionId}.jsonl`,
          parts: [],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    );
  }
  if (landedWorktree) {
    applySnapshot(fixture.models.worktrees, {
      worktrees: [
        {
          projectPath: "/project",
          worktreePath: "/worktree",
          branch: "agent/feature",
          baseBranch: "main",
          createdAt: "2026-01-01T00:00:00.000Z",
          state: "landed",
        },
      ],
    });
  }
  fixture.root.appShellStore.selectProjectSession("one");
  fixture.root.projectWorkbenchStore.showLoadedSession("one");
  fixture.root.sessionLayoutStore.ensureSession("one");
  // External subscription readiness is routed here exactly as in terminal-events.ts.
  if (eventsReady) fixture.root.terminalStore.readyForEvents();
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    open,
    close,
    connected() {
      act(() => fixture.root.terminalStore.readyForEvents());
    },
    disconnected() {
      // The transport connection callback in main.ts/browser-main.ts owns this routing.
      act(() => fixture.root.terminalStore.disconnected());
    },
    output(terminalId: string, data: string) {
      act(() => fixture.root.terminalStore.receive({ type: "terminal-data", terminalId, data }));
    },
    exited(terminalId: string, exitCode: number) {
      act(() =>
        fixture.root.terminalStore.receive({ type: "terminal-exited", terminalId, exitCode }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// These workflows exercise real TerminalView/xterm with the repository's DOM-only browser
// setup. Native typing, PTY output rendering, focus, and resize geometry remain Electron contracts.
// Generic retirement warnings, confirmation, inspection errors, and close-before-resolve ordering
// live in working-directory-retirement-workflow.test.tsx; the cases here cover terminal-specific
// pending-open cleanup and new-tab gating, not another copy of those retirement workflows.
describe("Terminal workflow", () => {
  it("opens lazily only after output subscription readiness and hides without closing the shell", async () => {
    using fixture = renderTerminal({ eventsReady: false });
    const toggle = screen.getByRole("button", { name: "Terminal" });
    expect(toggle).toHaveProperty("disabled", true);
    await fixture.user.click(toggle);
    expect(fixture.open).not.toHaveBeenCalled();
    fixture.connected();
    expect(toggle).toHaveProperty("disabled", false);
    expect(fixture.open).not.toHaveBeenCalled();
    await fixture.user.click(toggle);
    expect(await screen.findByRole("tab", { name: "zsh" })).toBeDefined();
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith({
      target: { workingDirectory: "/project" },
      cols: 80,
      rows: 24,
    });
    await fixture.user.click(screen.getByRole("button", { name: "Hide terminal" }));
    expect(screen.queryByRole("region", { name: "Terminal" })).toBeNull();
    expect(fixture.close).not.toHaveBeenCalled();
    await fixture.user.click(toggle);
    expect(screen.getByRole("tab", { name: "zsh" })).toBeDefined();
    expect(fixture.open).toHaveBeenCalledTimes(1);
  });

  it("shares and switches tabs between sessions in the same directory", async () => {
    using fixture = renderTerminal();
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    const first = await screen.findByRole("tab", { name: "zsh 1" });
    const second = await screen.findByRole("tab", { name: "zsh 2" });
    expect(second.getAttribute("aria-selected")).toBe("true");
    await fixture.user.click(first);
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("false");
    await fixture.user.click(screen.getByRole("button", { name: /^Second task / }));
    expect(screen.getByRole("tab", { name: "zsh 1" }).getAttribute("aria-selected")).toBe("true");
    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it("keeps another checkout separate and restores the original directory's tabs", async () => {
    using fixture = renderTerminal();
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    await fixture.user.click(await screen.findByRole("tab", { name: "zsh 1" }));
    await fixture.user.click(screen.getByRole("button", { name: /^Other checkout / }));
    expect(await screen.findByRole("tab", { name: "zsh" })).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(fixture.open).toHaveBeenLastCalledWith({
      target: { workingDirectory: "/worktree" },
      cols: 80,
      rows: 24,
    });
    await fixture.user.click(screen.getByRole("button", { name: /^First task / }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "zsh 1" }).getAttribute("aria-selected")).toBe("true");
    expect(fixture.open).toHaveBeenCalledTimes(3);
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it("moves the panel without replacing tabs and closes only the selected shell", async () => {
    using fixture = renderTerminal();
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    await fixture.user.click(await screen.findByRole("tab", { name: "zsh 1" }));
    await fixture.user.click(screen.getByRole("button", { name: "Pin terminal to bottom" }));
    await fixture.user.click(screen.getByRole("button", { name: "Move terminal to top" }));
    expect(screen.getByRole("button", { name: "Pin terminal to bottom" })).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "zsh 1" }).getAttribute("aria-selected")).toBe("true");
    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(fixture.close).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Close zsh tab" }));
    expect(await screen.findByRole("tab", { name: "zsh" })).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(fixture.close).toHaveBeenCalledExactlyOnceWith("terminal-1");
  });

  it("shows an open failure and shell exit, with deliberate retries instead of silently reopening", async () => {
    const open = vi
      .fn<Client["terminals"]["open"]>()
      .mockRejectedValueOnce(new Error("Shell unavailable"))
      .mockResolvedValueOnce({ terminalId: "recovered", shell: "bash" })
      .mockResolvedValueOnce({ terminalId: "restarted", shell: "zsh" });
    using fixture = renderTerminal({ terminals: { open } });
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(await screen.findByText("Shell unavailable")).toBeDefined();
    expect(open).toHaveBeenCalledTimes(1);
    await fixture.user.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(await screen.findByRole("tab", { name: "bash" })).toBeDefined();
    fixture.exited("recovered", 7);
    expect(screen.getByText("Shell exited with code 7")).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
    await fixture.user.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(await screen.findByRole("tab", { name: "zsh" })).toBeDefined();
    expect(open).toHaveBeenCalledTimes(3);
  });

  it.each(["opens", "fails"] as const)(
    "does not resurrect a retired tab when its pending open %s",
    async (outcome) => {
      const opening = deferred<OpenedTerminal>();
      const resolving =
        deferred<Awaited<ReturnType<Client["projectSessions"]["resolveWorkingDirectory"]>>>();
      const resolve = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
        () => resolving.promise,
      );
      using fixture = renderTerminal({
        terminals: {
          open: vi
            .fn<Client["terminals"]["open"]>()
            .mockImplementationOnce(() => opening.promise)
            .mockResolvedValue({ terminalId: "root-terminal", shell: "zsh" }),
          workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
          closeWorkingDirectory: async () => undefined,
        },
        landedWorktree: true,
        resolveWorkingDirectory: resolve,
      });
      await fixture.user.click(screen.getByRole("button", { name: /^Other checkout / }));
      await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
      expect(screen.getByRole("tab", { name: "Starting…" })).toBeDefined();
      await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      await act(async () => {
        if (outcome === "opens") opening.resolve({ terminalId: "late-terminal", shell: "bash" });
        else opening.reject(new Error("Directory removed"));
      });
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      expect(screen.queryByText("Directory removed")).toBeNull();
      if (outcome === "opens") expect(fixture.close).toHaveBeenCalledWith("late-terminal");
      else expect(fixture.close).not.toHaveBeenCalled();
      expect(fixture.open).toHaveBeenCalledTimes(1);
      await act(async () =>
        resolving.resolve({
          projectPath: "/project",
          workingDirectory: "/worktree",
          resolvedSessionIds: ["other"],
          failures: [],
        }),
      );
      expect(await screen.findByRole("tab", { name: "zsh" })).toBeDefined();
      expect(fixture.open).toHaveBeenLastCalledWith({
        target: { workingDirectory: "/project" },
        cols: 80,
        rows: 24,
      });
    },
  );

  it("blocks new tabs during inspection and confirmation, then permits them after cancellation", async () => {
    const inspection = deferred<{ runningProgramCount: number }>();
    const closeWorkingDirectory = vi.fn<Client["terminals"]["closeWorkingDirectory"]>(
      async () => undefined,
    );
    using fixture = renderTerminal({
      terminals: {
        workingDirectoryStatus: () => inspection.promise,
        closeWorkingDirectory,
      },
      landedWorktree: true,
    });
    await fixture.user.click(screen.getByRole("button", { name: /^Other checkout / }));
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(fixture.open).toHaveBeenCalledTimes(1);
    await act(async () => inspection.resolve({ runningProgramCount: 1 }));
    expect(
      await screen.findByRole("dialog", { name: "Retire and stop running program?" }),
    ).toBeDefined();
    // The panel sits behind the confirmation backdrop; its app shortcut remains a real
    // route for requesting a tab. This asserts routing, not native keyboard correctness.
    await fixture.user.keyboard(isMacPlatform ? "{Meta>}t{/Meta}" : "{Control>}t{/Control}");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(fixture.open).toHaveBeenCalledTimes(1);
    await fixture.user.click(screen.getByRole("button", { name: "Cancel" }));
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(await screen.findByRole("tab", { name: "zsh 2" })).toBeDefined();
    expect(fixture.open).toHaveBeenCalledTimes(2);
    expect(closeWorkingDirectory).not.toHaveBeenCalled();
  });

  it("keeps new tabs blocked until idle directory shells have finished closing", async () => {
    const closing = deferred<void>();
    const resolving =
      deferred<Awaited<ReturnType<Client["projectSessions"]["resolveWorkingDirectory"]>>>();
    const closeWorkingDirectory = vi.fn<Client["terminals"]["closeWorkingDirectory"]>(
      () => closing.promise,
    );
    const resolve = vi.fn<Client["projectSessions"]["resolveWorkingDirectory"]>(
      () => resolving.promise,
    );
    using fixture = renderTerminal({
      terminals: {
        workingDirectoryStatus: async () => ({ runningProgramCount: 0 }),
        closeWorkingDirectory,
      },
      landedWorktree: true,
      resolveWorkingDirectory: resolve,
    });
    await fixture.user.click(screen.getByRole("button", { name: /^Other checkout / }));
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(closeWorkingDirectory).toHaveBeenCalledTimes(1));
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(fixture.open).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
    await act(async () => closing.resolve());
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    await act(async () =>
      resolving.resolve({
        projectPath: "/project",
        workingDirectory: "/worktree",
        resolvedSessionIds: ["other"],
        failures: [],
      }),
    );
    await screen.findByRole("tab", { name: "zsh" });
    await fixture.user.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(await screen.findByRole("tab", { name: "zsh 2" })).toBeDefined();
    expect(fixture.open).toHaveBeenCalledTimes(3);
  });

  it("retains output received before the open response in the real terminal surface", async () => {
    const opening = deferred<OpenedTerminal>();
    using fixture = renderTerminal({ terminals: { open: () => opening.promise } });
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    fixture.output("early-terminal", "prompt> ");
    await act(async () => opening.resolve({ terminalId: "early-terminal", shell: "zsh" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Terminal" }).textContent).toContain("prompt>"),
    );
  });

  it("discards a disconnected socket's late open and requires reconnection plus an explicit restart", async () => {
    const opening = deferred<OpenedTerminal>();
    const open = vi
      .fn<Client["terminals"]["open"]>()
      .mockImplementationOnce(() => opening.promise)
      .mockResolvedValueOnce({ terminalId: "new-terminal", shell: "bash" });
    using fixture = renderTerminal({ terminals: { open } });
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("tab", { name: "Starting…" })).toBeDefined();
    fixture.disconnected();
    expect(screen.getByText(/Connection lost/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty("disabled", true);
    await act(async () => opening.resolve({ terminalId: "old-terminal", shell: "zsh" }));
    await waitFor(() => expect(fixture.close).toHaveBeenCalledWith("old-terminal"));
    await fixture.user.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(open).toHaveBeenCalledTimes(1);
    fixture.connected();
    expect(screen.getByText(/Connection lost/)).toBeDefined();
    expect(open).toHaveBeenCalledTimes(1);
    await fixture.user.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(await screen.findByRole("tab", { name: "bash" })).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
