/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChanges } from "../../../src/contracts/worktrees/worktree-changes";
import type { Client } from "../../../src/renderer/client/Client";
import {
  editorLease,
  editorWorkingDirectory,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";
import { sessionSummary } from "./fixtures/catalog-fixtures";

const changes: WorktreeChanges = {
  branch: "agent/review",
  base: "main",
  commits: [
    {
      hash: "abc1234567",
      subject: "Add review pane",
      files: [
        {
          path: "committed.ts",
          deleted: false,
          workingTreeExists: true,
          additions: 18,
          deletions: 3,
        },
        {
          path: "earlier.ts",
          deleted: false,
          workingTreeExists: false,
          additions: 4,
          deletions: 0,
        },
        { path: "removed.ts", deleted: true, workingTreeExists: false, additions: 0, deletions: 8 },
      ],
    },
    {
      hash: "def1234567",
      subject: "Add artwork",
      files: [
        {
          path: "image.png",
          deleted: false,
          workingTreeExists: true,
          additions: null,
          deletions: null,
        },
      ],
    },
  ],
  staged: [
    { path: "staged.ts", deleted: false, workingTreeExists: true, additions: 10, deletions: 2 },
  ],
  unstaged: [
    { path: "working.ts", deleted: false, workingTreeExists: true, additions: 7, deletions: 1 },
  ],
};

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  vi.stubGlobal("matchMedia", (query: string) => ({
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderChanges(data = changes) {
  const inspectChanges = vi.fn<Client["managedWorktrees"]["inspectChanges"]>(async (path) =>
    path === "/other"
      ? { branch: "other", base: "main", commits: [], staged: [], unstaged: [] }
      : data,
  );
  const prepareFileLocation = vi.fn<Client["filesystem"]["prepareFileLocation"]>(
    async ({ location }) => ({ viewer: "vscode", location }),
  );
  const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
    outcome: { view: "file" },
    locations: [],
  }));
  const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
  const fixture = renderEmbeddedEditor(
    {
      managedWorktrees: { inspectChanges, landing: async () => ({}) },
      filesystem: { prepareFileLocation },
      vscode: { open: async () => editorLease("a"), reveal, openSourceControl },
    },
    {
      additionalSessions: [
        sessionSummary({
          sessionId: "other-session",
          title: "Other session",
          projectPath: "/other",
          workingDirectory: "/other",
        }),
      ],
    },
  );
  return { ...fixture, inspectChanges, prepareFileLocation, reveal, openSourceControl };
}

async function openChanges(fixture: ReturnType<typeof renderChanges>) {
  const toggle = await screen.findByRole("button", { name: "Review changes · 2 commits" });
  expect(toggle.textContent).toBe("2");
  await fixture.user.click(toggle);
  return screen.findByRole("complementary", { name: "Changes" });
}

describe("Session Changes review", () => {
  it("counts commits, expands real file deltas, and separates staged and unstaged changes", async () => {
    using fixture = renderChanges();
    const pane = await openChanges(fixture);
    expect(within(pane).getByText("agent/review")).toBeDefined();
    await fixture.user.click(within(pane).getByRole("button", { name: /Add review pane/ }));
    const committed = within(pane).getByRole("button", { name: /committed.ts/ });
    expect(within(committed).getByText("+18")).toBeDefined();
    expect(within(committed).getByText("−3")).toBeDefined();
    const staged = within(pane).getByRole("region", { name: "Staged" });
    const unstaged = within(pane).getByRole("region", { name: "Unstaged" });
    const stagedFile = within(staged).getByRole("button", { name: /staged.ts/ });
    expect(within(stagedFile).getByText("+10")).toBeDefined();
    expect(within(stagedFile).getByText("−2")).toBeDefined();
    const workingFile = within(unstaged).getByRole("button", { name: /working.ts/ });
    expect(within(workingFile).getByText("+7")).toBeDefined();
    expect(within(workingFile).getByText("−1")).toBeDefined();
    await fixture.user.click(within(pane).getByRole("button", { name: /Add artwork/ }));
    expect(
      within(within(pane).getByRole("button", { name: /image.png/ })).getByText("Binary"),
    ).toBeDefined();
    await fixture.user.click(within(pane).getByRole("button", { name: "Close Changes" }));
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    await fixture.user.click(
      await screen.findByRole("button", { name: "Review changes · 2 commits" }),
    );
    await fixture.user.click(
      await screen.findByRole("button", { name: "Review changes · 2 commits" }),
    );
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
  });

  it.each([
    {
      path: "committed.ts",
      commit: true,
      location: { kind: "working-directory", path: "committed.ts" },
    },
    {
      path: "earlier.ts",
      commit: true,
      location: {
        kind: "working-directory",
        path: "earlier.ts",
        view: "changes",
        side: "before",
        base: "abc1234567",
      },
    },
    {
      path: "removed.ts",
      commit: true,
      location: {
        kind: "working-directory",
        path: "removed.ts",
        view: "changes",
        side: "before",
        base: "abc1234567^",
      },
    },
    {
      path: "staged.ts",
      commit: false,
      location: { kind: "working-directory", path: "staged.ts", view: "changes" },
    },
    {
      path: "working.ts",
      commit: false,
      location: { kind: "working-directory", path: "working.ts", view: "changes" },
    },
  ])(
    "opens $path through the existing editor-location workflow",
    async ({ path, commit, location }) => {
      using fixture = renderChanges();
      const pane = await openChanges(fixture);
      if (commit)
        await fixture.user.click(within(pane).getByRole("button", { name: /Add review pane/ }));
      await fixture.user.click(within(pane).getByRole("button", { name: new RegExp(path) }));
      await waitFor(() =>
        expect(fixture.prepareFileLocation).toHaveBeenCalledWith(
          {
            workspacePath: editorWorkingDirectory,
            originatingDirectory: editorWorkingDirectory,
            location,
          },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await waitFor(() =>
        expect(fixture.reveal).toHaveBeenCalledWith(
          editorWorkingDirectory,
          location,
          expect.any(Object),
        ),
      );
    },
  );

  it("opens embedded VS Code Source Control through the existing workspace changes action", async () => {
    using fixture = renderChanges();
    const pane = await openChanges(fixture);
    await fixture.user.click(within(pane).getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() =>
      expect(fixture.openSourceControl).toHaveBeenCalledWith(
        editorWorkingDirectory,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("keeps review state scoped to its session", async () => {
    using fixture = renderChanges();
    await openChanges(fixture);
    await fixture.user.click(screen.getByText("Other session", { exact: true }));
    const toggle = await screen.findByRole("button", { name: "Review changes · 0 commits" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    await fixture.user.click(toggle);
    expect(await screen.findByText("No commits")).toBeDefined();
    expect(await screen.findByText("Working tree clean")).toBeDefined();
    await fixture.user.click(screen.getByText("Editor conversation", { exact: true }));
    expect(
      (await screen.findByRole("button", { name: "Review changes · 2 commits" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeDefined();
  });
});
