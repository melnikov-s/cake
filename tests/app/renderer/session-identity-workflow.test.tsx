/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { fixtureTimestamp } from "./fixtures/catalog-fixtures";
import { identityProjectPath, renderSessionIdentity } from "./session-identity-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Pane registration only; native geometry and focus are not asserted here.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

function inputs() {
  return screen.getAllByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
}
function paneFor(input: HTMLElement) {
  const pane = input.closest("section");
  if (!pane) throw new Error("Missing session pane");
  return within(pane);
}

describe("Session identity workflows", () => {
  it("routes terminal actions through authoritative identity and falls back to the loaded directory after catalog removal", async () => {
    const open = vi.fn<Client["terminals"]["open"]>(async ({ target }) => ({
      terminalId: target.workingDirectory,
      shell: target.workingDirectory === identityProjectPath ? "loaded-shell" : "authority-shell",
    }));
    using fixture = renderSessionIdentity({
      terminalReady: true,
      client: { terminals: { open, close: async () => undefined } },
    });
    // The selected temporary identity already exists at /project. Catalog updates arrive
    // independently; they must take precedence without rewriting that loaded identity.
    fixture.publishCreatedSession("/authoritative");
    await fixture.user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(await screen.findByRole("tab", { name: "authority-shell" })).toBeDefined();
    expect(open).toHaveBeenLastCalledWith({
      target: { workingDirectory: "/authoritative" },
      cols: 80,
      rows: 24,
    });

    fixture.publishSessions([]);
    expect(await screen.findByRole("tab", { name: "loaded-shell" })).toBeDefined();
    expect(open).toHaveBeenLastCalledWith({
      target: { workingDirectory: identityProjectPath },
      cols: 80,
      rows: 24,
    });
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("restores independent unsent pane inputs and closing one leaves the other usable", async () => {
    const start = vi.fn<Client["projectSessions"]["start"]>();
    let snapshot: StoreSnapshot;
    {
      using fixture = renderSessionIdentity({ client: { projectSessions: { start } } });
      await fixture.user.type(inputs()[0]!, "Keep original task");
      await fixture.user.click(screen.getByRole("button", { name: "Split right" }));
      await waitFor(() => expect(inputs()).toHaveLength(2));
      await fixture.user.type(inputs()[1]!, "Independent second task");
      expect(inputs().map((input) => input.value)).toEqual([
        "Keep original task",
        "Independent second task",
      ]);
      snapshot = fixture.snapshot();
    }
    using restored = renderSessionIdentity({ snapshot, client: { projectSessions: { start } } });
    expect(inputs().map((input) => input.value)).toEqual([
      "Keep original task",
      "Independent second task",
    ]);
    await restored.user.click(paneFor(inputs()[0]!).getByRole("button", { name: "Close pane" }));
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]!.value).toBe("Independent second task");
    await restored.user.type(inputs()[0]!, " with retained context");
    expect(inputs()[0]!.value).toBe("Independent second task with retained context");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("replaces the new-checkout creation fact with authoritative status and never resurrects it after removal", async () => {
    const record: WorktreeRecord = {
      projectPath: identityProjectPath,
      worktreePath: "/worktrees/created-checkout",
      branch: "agent/created-checkout",
      baseBranch: "main",
      state: "active",
      createdAt: fixtureTimestamp,
    };
    const create = vi.fn<Client["managedWorktrees"]["create"]>(async () => record);
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderSessionIdentity({
      client: { managedWorktrees: { create }, projectSessions: { start } },
    });
    await fixture.user.click(screen.getByRole("button", { name: "New worktree" }));
    await fixture.user.type(inputs()[0]!, "Prepare checkout");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "staged-original",
        workingDirectory: record.worktreePath,
        text: "Prepare checkout",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect((await screen.findAllByTitle("Open worktree")).length).toBeGreaterThan(0);
    // The start response is enough to bridge the icon before the worktree stream catches up.
    fixture.publishCreatedSession(record.worktreePath);
    fixture.publishWorktrees([{ ...record, state: "landed" }]);
    expect(screen.getAllByTitle("Merged worktree").length).toBeGreaterThan(0);
    expect(screen.queryByTitle("Open worktree")).toBeNull();
    fixture.publishWorktrees([]);
    expect(screen.queryByTitle("Merged worktree")).toBeNull();
    expect(screen.queryByTitle("Open worktree")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });
});
