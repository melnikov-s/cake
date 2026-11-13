/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
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
  baseAlternatives: [],
  totalCommits: 2,
  baseRevision: "fork-sha",
  headRevision: "head-sha",
  files: [],
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

function renderChanges(
  data: Client["managedWorktrees"]["inspectChanges"] | WorktreeChanges = changes,
) {
  const inspectChanges = vi.fn<Client["managedWorktrees"]["inspectChanges"]>(
    async (input, options) =>
      input.workspacePath === "/other"
        ? {
            branch: "other",
            base: "main",
            baseAlternatives: [],
            commits: [],
            totalCommits: 0,
            baseRevision: "other-fork",
            headRevision: "other-head",
            files: [],
            staged: [],
            unstaged: [],
          }
        : typeof data === "function"
          ? data(input, options)
          : data,
  );
  const prepareFileLocation = vi.fn<Client["filesystem"]["prepareFileLocation"]>(
    async ({ location }) => ({ viewer: "vscode", location }),
  );
  const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
    outcome: { view: "file" },
    locations: [],
  }));
  const open = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
  const openSourceControl = vi.fn<Client["vscode"]["openSourceControl"]>(async () => undefined);
  const fixture = renderEmbeddedEditor(
    {
      managedWorktrees: { inspectChanges, landing: async () => ({}) },
      filesystem: { prepareFileLocation },
      vscode: { open, reveal, openSourceControl },
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
  return { ...fixture, inspectChanges, prepareFileLocation, reveal, open, openSourceControl };
}

async function openChanges(fixture: ReturnType<typeof renderChanges>, commits = 2) {
  const toggle = await screen.findByRole("button", {
    name: `Review changes · ${commits} commits`,
  });
  // The bubble caps at 99+; the accessible name keeps the exact count.
  expect(toggle.textContent).toBe(commits > 99 ? "99+" : String(commits));
  await fixture.user.click(toggle);
  return screen.findByRole("complementary", { name: "Changes" });
}

describe("Session Changes review", () => {
  it.each(
    (["chat", "todos", "sessions"] as const).flatMap((tab) =>
      [true, false].map((shown) => ({ tab, shown })),
    ),
  )(
    "VS Code Changes replaces $tab (shown=$shown) and restores its exact visibility",
    async ({ tab, shown }) => {
      using fixture = renderChanges();
      await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
      const navigator = fixture.root.workspaceNavigatorStore;
      act(() => (tab === "chat" ? navigator.showChat() : navigator.show(tab)));
      const companion = () =>
        screen.queryByRole("complementary", { name: "Current conversation companion" });
      if (!shown) await fixture.user.click(screen.getByRole("button", { name: "Close Workspace" }));
      const editor = fixture.root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
      const workspace = screen.getByRole("region", { name: "VS Code workspace" });
      const frame = await screen.findByTitle("VS Code workspace");
      const width = editor.chatSidebarWidth;
      expect(editor.chatSidebarVisible).toBe(shown);
      expect(Boolean(companion())).toBe(shown);

      const pane = await openChanges(fixture);
      expect(companion()?.contains(pane)).toBe(true);
      expect(screen.queryByRole("group", { name: "Companion content" })).toBeNull();
      expect(within(pane).getByText("agent/review")).toBeDefined();
      await fixture.user.click(within(pane).getByRole("button", { name: /Add review pane/ }));
      await fixture.user.click(within(pane).getByRole("button", { name: /committed.ts/ }));
      expect(fixture.reveal).toHaveBeenLastCalledWith(
        editorWorkingDirectory,
        { kind: "working-directory", path: "committed.ts" },
        expect.anything(),
      );
      expect(workspace.isConnected).toBe(true);
      expect(screen.getByTitle("VS Code workspace")).toBe(frame);
      expect(editor.chatSidebarVisible).toBe(shown);
      expect(editor.chatSidebarWidth).toBe(width);
      await fixture.user.click(within(pane).getByRole("button", { name: "Close Changes" }));
      expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
      expect(Boolean(companion())).toBe(shown);
      expect(navigator.companionTab).toBe(tab);
      expect(editor.chatSidebarVisible).toBe(shown);
      expect(screen.getByTitle("VS Code workspace")).toBe(frame);

      // Repeated opens must not turn a temporary replacement into a saved preference.
      await openChanges(fixture);
      await fixture.user.click(screen.getByRole("button", { name: "Review changes · 2 commits" }));
      expect(Boolean(companion())).toBe(shown);
      expect(navigator.companionTab).toBe(tab);
    },
  );

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

  it("closes Changes only after embedded VS Code Source Control opens successfully", async () => {
    using fixture = renderChanges();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    fixture.openSourceControl.mockReturnValueOnce(pending);
    const pane = await openChanges(fixture);
    await fixture.user.click(within(pane).getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() =>
      expect(fixture.openSourceControl).toHaveBeenCalledWith(
        editorWorkingDirectory,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      screen.getByRole("complementary", { name: "Changes" }).classList.contains("side-chat-panel"),
    ).toBe(false);
    await act(async () => complete());
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull(),
    );
  });

  it.each(["open", "openSourceControl"] as const)(
    "keeps Changes available and preserves the editor error when %s fails",
    async (operation) => {
      using fixture = renderChanges();
      fixture[operation].mockRejectedValueOnce(new Error("VS Code unavailable"));
      const pane = await openChanges(fixture);
      await fixture.user.click(within(pane).getByRole("button", { name: "Open in VS Code" }));
      expect(await screen.findByText("VS Code unavailable")).toBeDefined();
      const retainedPane = screen.getByRole("complementary", { name: "Changes" });
      if (operation === "open") expect(fixture.openSourceControl).not.toHaveBeenCalled();
      await fixture.user.click(within(retainedPane).getByRole("button", { name: "Close Changes" }));
      expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    },
  );

  it("keeps review state scoped to its session", async () => {
    using fixture = renderChanges();
    await openChanges(fixture);
    await fixture.user.click(screen.getByRole("button", { name: "Search sessions" }));
    await fixture.user.click(screen.getByRole("option", { name: /^Other session / }));
    const toggle = await screen.findByRole("button", { name: "Review changes · 0 commits" });
    expect(within(toggle).getByText("0").classList.contains("bg-card")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    await fixture.user.click(toggle);
    expect(await screen.findByText("No commits")).toBeDefined();
    expect(await screen.findByText("Working tree clean")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Search sessions" }));
    await fixture.user.click(screen.getByRole("option", { name: /^Editor conversation / }));
    expect(
      (await screen.findByRole("button", { name: "Review changes · 2 commits" })).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(await screen.findByRole("complementary", { name: "Changes" })).toBeDefined();
  });

  it("compares with the inferred parent and lets the user switch among tied bases", async () => {
    const stacked: WorktreeChanges = {
      ...changes,
      base: "agent/parent",
      baseAlternatives: [
        { branch: "agent/parent", distance: 2 },
        { branch: "main", distance: 2 },
      ],
    };
    using fixture = renderChanges(async (input) =>
      input.base === "main" ? { ...stacked, base: "main" } : stacked,
    );
    const pane = await openChanges(fixture);
    const picker = within(pane).getByRole("combobox", { name: "Compare with" });
    expect((picker as HTMLSelectElement).value).toBe("agent/parent");
    await fixture.user.selectOptions(picker, "main");
    await waitFor(() =>
      expect(fixture.inspectChanges).toHaveBeenLastCalledWith(
        { workspacePath: editorWorkingDirectory, base: "main" },
        expect.any(Object),
      ),
    );
    await waitFor(() => expect((picker as HTMLSelectElement).value).toBe("main"));
  });

  it("shows net outstanding totals separately from historical commit edits and opens the exact revision diff", async () => {
    using fixture = renderChanges({
      ...changes,
      files: [
        { path: "net.ts", additions: 2, deletions: 1, deleted: false, workingTreeExists: true },
      ],
    });
    const pane = await openChanges(fixture);
    const outstanding = within(pane).getByRole("region", { name: "Outstanding changes" });
    expect(within(outstanding).getAllByText("+2")).toHaveLength(2);
    expect(within(outstanding).queryByText("+22")).toBeNull();
    await fixture.user.click(within(outstanding).getByRole("button", { name: /net.ts/ }));
    expect(fixture.reveal).toHaveBeenLastCalledWith(
      editorWorkingDirectory,
      {
        kind: "working-directory",
        path: "net.ts",
        view: "changes",
        base: "fork-sha",
        revision: "head-sha",
        side: "after",
      },
      expect.anything(),
    );
  });

  it("explains a capped commit list", async () => {
    using fixture = renderChanges({ ...changes, totalCommits: 8156 });
    const pane = await openChanges(fixture, 8156);
    expect(within(pane).getByText("Showing 2 of 8156 commits")).toBeDefined();
  });

  it("keeps a Git failure visible while a later refresh is still running", async () => {
    let calls = 0;
    using fixture = renderChanges(async () => {
      // The first read fails; the refresh triggered by opening the pane never settles.
      if (calls++ === 0) throw new Error("git log failed: stdout maxBuffer length exceeded");
      return new Promise<never>(() => {});
    });
    await fixture.user.click(await screen.findByRole("button", { name: "Review changes" }));
    const pane = await screen.findByRole("complementary", { name: "Changes" });
    expect(
      await within(pane).findByText("git log failed: stdout maxBuffer length exceeded"),
    ).toBeDefined();
    expect(calls).toBe(2);
  });
});
