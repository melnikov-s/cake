/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { Schema } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../src/contracts/artifacts/artifact-lineage";
import type { Client } from "../../../src/renderer/client/Client";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const effective = (
  revision = 2,
  id = "shared",
  title = "Family report",
): EffectiveArtifactProjection =>
  Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    revision: {
      lineageId: id,
      metadata: {
        revision,
        digest: "a".repeat(64),
        kind: "markdown",
        publishedAt: new Date(Date.UTC(2025, 0, revision)).toISOString(),
        publishedBySessionId: "session-1",
        workingDirectory: "/project",
      },
      snapshot: {
        protocol: "cake.artifact/v1",
        id,
        sessionId: "session-1",
        revision,
        title,
        kind: "markdown",
        payload: { markdown: `${title} content r${revision}` },
        fallback: { markdown: `${title} content r${revision}` },
      },
    },
    link: {
      lineageId: id,
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    latestRevision: revision,
    stableRef: `cake://artifact/${id}`,
    exactRef: `cake://artifact/${id}@r${revision}`,
  });

const reportSummary = () => ({
  id: effective().revision.lineageId,
  title: "Family report",
  createdAt: effective(1).revision.metadata.publishedAt,
  latestRevision: effective().latestRevision,
  latest: effective().revision.metadata,
  stableRef: effective().stableRef,
});

function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderSessionArtifacts(
  artifacts: Partial<Client["artifacts"]> = {},
  initial?: EffectiveArtifactProjection[],
  parts: UiPart[] = [],
  inlineWidgets: Partial<Client["inlineWidgets"]> = {},
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: ["session-1", "session-2"].map((id) =>
      sessionSummary({
        sessionId: id,
        title: id === "session-1" ? "Parent session" : "Child session",
        projectPath: "/project",
        familyId: "family-1",
        ...(id === "session-2"
          ? { familyParentSessionId: "session-1", familyDepth: 1 }
          : { familyChildSessionIds: ["session-2"], familyDepth: 0 }),
      }),
    ),
    client: {
      projectSessions: { open: async () => undefined },
      workspaces: { loadStagedSlashCommands: async () => [] },
      inlineWidgets,
      artifacts: {
        effective: async () => [effective()],
        catalog: async () => ({
          items: [reportSummary()],
          offset: 0,
          limit: 50,
          total: 1,
          hasMore: false,
        }),
        detail: async () => ({
          lineage: reportSummary(),
          links: [effective().link],
          stableRef: effective().stableRef,
        }),
        history: async () => ({
          items: [effective(2).revision.metadata, effective(1).revision.metadata],
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false,
        }),
        readExact: async (_id, revision) => effective(revision).revision,
        ...artifacts,
      },
    },
  });
  if (initial) fixture.models.artifacts.applyEffective("session-1", initial);
  for (const id of ["session-1", "session-2"]) {
    fixture.root.sessionRegistry.load(id, "/project");
    applyConversationUpdate(fixture.models.projectConversation(id, "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: id,
        sessionFile: `/sessions/${id}.jsonl`,
        parts: id === "session-1" ? parts : [],
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
    });
  }
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
  fixture.root.sessionRegistry
    .load("session-1", "/project")
    .conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 900, itemHeight: 160 }}>
      <StoreProvider store={fixture.root}>
        <RendererRoot rootStore={fixture.root} openExternalUrl={vi.fn()} openSession={vi.fn()} />
      </StoreProvider>
    </VirtuosoMockContext.Provider>,
  );
  return {
    user: userEvent.setup(),
    invalidate: () => fixture.root.refreshSessionArtifacts(),
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

const visual = (revision: number) => {
  const value = effective(revision, "visual", "Visual explanation");
  return Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    ...value,
    latestRevision: 2,
    revision: {
      ...value.revision,
      metadata: { ...value.revision.metadata, kind: "widget" },
      snapshot: {
        ...value.revision.snapshot,
        kind: "widget",
        payload: {
          language: "html",
          source: `<strong>Explanation r${revision}</strong>`,
          brief: "A visual explanation",
          generationSessionId: "generation-session",
          browser: { digest: "b".repeat(64) },
        },
        fallback: { markdown: `Explanation r${revision}` },
      },
    },
  });
};

const visualPart: UiPart = {
  id: "tool-visual",
  kind: "tool",
  name: "cake",
  command: "widgets.present",
  input: "",
  state: "success",
  artifactId: "visual",
  artifactRevision: 1,
};

const visualMetadata = () => ({
  lineage: {
    id: visual(2).revision.lineageId,
    createdAt: "2025-01-01T00:00:00.000Z",
    latestRevision: visual(2).revision.metadata.revision,
    latest: visual(2).revision.metadata,
    title: "Visual explanation",
    stableRef: visual(2).stableRef,
  },
  revision: visual(1).revision.metadata,
  links: [visual(2).link],
  stableRef: visual(2).stableRef,
  exactRef: visual(1).exactRef,
});

describe("Session artifact workflows", () => {
  it("updates already-open publication and pane instances while keeping an explicit historical embed and history selection pinned", async () => {
    let latest = 1;
    const summary = () => ({
      ...reportSummary(),
      latestRevision: effective(latest).latestRevision,
      latest: effective(latest).revision.metadata,
    });
    using fixture = renderSessionArtifacts(
      {
        effective: async () => [effective(latest)],
        catalog: async () => ({
          items: [summary()],
          offset: 0,
          limit: 50,
          total: 1,
          hasMore: false,
        }),
        detail: async () => ({
          lineage: summary(),
          links: [effective(latest).link],
          stableRef: effective().stableRef,
        }),
        referenceMetadata: async () => ({
          lineage: summary(),
          revision: effective(latest).revision.metadata,
          links: [effective(latest).link],
          stableRef: effective().stableRef,
          exactRef: effective(latest).exactRef,
        }),
      },
      [effective(1)],
      [
        { ...visualPart, artifactId: "shared", artifactRevision: 1 },
        {
          id: "history",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: "![Historical report](cake://artifact/shared@r1)",
        },
      ],
    );
    await screen.findAllByText("Family report content r1");
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(
      within(await screen.findByRole("dialog", { name: "Artifacts" })).getByRole("button", {
        name: /Family report/,
      }),
    );
    await waitFor(() => expect(screen.getAllByText("Family report content r1")).toHaveLength(3));
    latest = 2;
    act(() => fixture.invalidate());
    await waitFor(() => expect(screen.getAllByText("Family report content r2")).toHaveLength(2));
    expect(screen.getAllByText("Family report content r1")).toHaveLength(1);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "1",
    );
    await waitFor(() => expect(screen.getAllByText("Family report content r1")).toHaveLength(2));
    latest = 3;
    act(() => fixture.invalidate());
    await screen.findByText("Family report content r3");
    expect(screen.getAllByText("Family report content r1")).toHaveLength(2);
  });

  it("retries an explicit historical embed and lets the user collapse it", async () => {
    const readExact = vi
      .fn<Client["artifacts"]["readExact"]>()
      .mockRejectedValue(new Error("Read temporarily unavailable"));
    // A controlled compiler failure exercises the readable fallback. Actual
    // script execution and theme/size changes are verified in Electron.
    const open = vi
      .fn<Client["inlineWidgets"]["open"]>()
      .mockRejectedValue(new Error("Compiler unavailable"));
    using fixture = renderSessionArtifacts(
      {
        effective: async () => [visual(2)],
        referenceMetadata: async () => visualMetadata(),
        readExact,
      },
      [visual(2)],
      [
        {
          id: "historical",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: "![Visual explanation](cake://artifact/visual@r1)",
        },
      ],
      { open },
    );
    await screen.findByRole("button", { name: "Visual explanation Collapse" });
    expect(await screen.findByText("Read temporarily unavailable")).toBeDefined();
    readExact.mockImplementation(async (_id, revision) => visual(revision).revision);
    await fixture.user.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() =>
      expect(document.querySelector('[data-artifact-id="visual"]')).not.toBeNull(),
    );
    expect(readExact).toHaveBeenLastCalledWith("visual", 1, expect.anything());
    expect(await screen.findByText("Explanation r1")).toBeDefined();
    expect(open).toHaveBeenCalledWith({ digest: "b".repeat(64) });
    await fixture.user.click(screen.getByRole("button", { name: "Visual explanation Collapse" }));
    expect(screen.queryByText("Explanation r1")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Visual explanation Expand" }));
    expect(await screen.findByText("Explanation r1")).toBeDefined();
    expect(readExact.mock.calls.every((call) => call[1] === 1)).toBe(true);
    // Inline expansion is independent of toolbar navigation.
    expect(screen.queryByRole("dialog", { name: "Artifacts" })).toBeNull();
  });

  it("renders document publications inline using their existing artifact renderer", async () => {
    const readExact = vi.fn<Client["artifacts"]["readExact"]>(async () => effective().revision);
    using fixture = renderSessionArtifacts(
      { readExact },
      [effective()],
      [
        {
          ...visualPart,
          artifactId: "shared",
          artifactRevision: 2,
        },
      ],
    );
    await screen.findByRole("button", { name: "1 artifacts" });
    expect(await screen.findByText("Family report content r2")).toBeDefined();
    expect(readExact).not.toHaveBeenCalled();
    await fixture.user.click(screen.getByRole("button", { name: "Family report Collapse" }));
    expect(screen.queryByText("Family report content r2")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Family report Expand" }));
    expect(await screen.findByText("Family report content r2")).toBeDefined();
  });

  it.each([1, 2])(
    "keeps explicit historical embeds separate from a following publication (r%s)",
    async (revision) => {
      const readExact = vi.fn<Client["artifacts"]["readExact"]>(
        async (_id, revision) => visual(revision).revision,
      );
      using fixture = renderSessionArtifacts(
        {
          effective: async () => [visual(2)],
          referenceMetadata: async () => visualMetadata(),
          readExact,
        },
        [visual(2)],
        [
          visualPart,
          {
            id: "assistant-embed",
            kind: "text",
            role: "assistant",
            status: "complete",
            text: `Follow-up explanation.\n\n![Visual explanation](cake://artifact/visual@r${revision})`,
          },
        ],
        {
          open: async () => {
            throw new Error("Compiler unavailable");
          },
        },
      );
      await screen.findAllByText("Explanation r2");
      expect(screen.getAllByRole("button", { name: "Visual explanation Collapse" })).toHaveLength(
        2,
      );
      expect(screen.getByText("Follow-up explanation.")).toBeDefined();
      if (revision === 1) expect(await screen.findByText("Explanation r1")).toBeDefined();
      if (revision === 1)
        expect(readExact).toHaveBeenLastCalledWith("visual", 1, expect.anything());
      else expect(readExact).not.toHaveBeenCalled();
      await fixture.user.click(
        screen.getAllByRole("button", { name: "Visual explanation Collapse" })[0]!,
      );
      expect(screen.getByRole("button", { name: "Visual explanation Expand" })).toBeDefined();
      expect(screen.getByText(`Explanation r${revision}`)).toBeDefined();
    },
  );

  it("expands a standalone Markdown embed without a publication tool", async () => {
    using fixture = renderSessionArtifacts(
      { effective: async () => [visual(2)] },
      [visual(2)],
      [
        {
          id: "standalone-embed",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: "![Visual explanation](cake://artifact/visual@r2)",
        },
      ],
      {
        open: async () => {
          throw new Error("Compiler unavailable");
        },
      },
    );
    expect(await screen.findByText("Explanation r2")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Visual explanation Collapse" })).toHaveLength(1);
    await fixture.user.click(screen.getByRole("button", { name: "Visual explanation Collapse" }));
    expect(screen.queryByText("Explanation r2")).toBeNull();
  });

  it("does not reopen a collapsed preview when its read finishes", async () => {
    const pending = gate<ReturnType<typeof visual>["revision"]>();
    const readExact = vi.fn<Client["artifacts"]["readExact"]>(() => pending.promise);
    using fixture = renderSessionArtifacts(
      {
        effective: async () => [visual(2)],
        referenceMetadata: async () => visualMetadata(),
        readExact,
      },
      [visual(2)],
      [
        {
          id: "historical",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: "![Visual explanation](cake://artifact/visual@r1)",
        },
      ],
    );
    await screen.findByRole("button", { name: "Visual explanation Collapse" });
    await waitFor(() => expect(readExact).toHaveBeenCalled());
    await fixture.user.click(screen.getByRole("button", { name: "Visual explanation Collapse" }));
    await act(async () => pending.resolve(visual(1).revision));
    expect(screen.getByRole("button", { name: "Visual explanation Expand" })).toBeDefined();
    expect(screen.queryByText("Explanation r1")).toBeNull();
  });
  it("opens a sole linked artifact in the detail pane and reopens its catalog after closing", async () => {
    using fixture = renderSessionArtifacts();
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    const popup = await screen.findByRole("dialog", { name: "Artifacts" });
    const list = within(popup).getByRole("navigation", { name: "Artifact list" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    await fixture.user.click(within(list).getByRole("button", { name: /Family report/ }));
    expect(await screen.findByText("Family report content r2")).toBeDefined();
    expect(screen.getByRole("complementary", { name: "Artifact" })).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Search artifact library" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Close Artifact" }));
    await fixture.user.click(screen.getByRole("button", { name: "1 artifacts" }));
    const reopenedPopup = await screen.findByRole("dialog", { name: "Artifacts" });
    const reopenedList = within(reopenedPopup).getByRole("navigation", { name: "Artifact list" });
    expect(within(reopenedList).getAllByRole("button")).toHaveLength(1);
    await fixture.user.click(within(reopenedList).getByRole("button", { name: /Family report/ }));
    expect(await screen.findByText("Family report content r2")).toBeDefined();
  });

  it("shows only the active session's linked artifacts, including shared family links", async () => {
    using fixture = renderSessionArtifacts({
      effective: async (id) =>
        id === "session-1" ? [effective(), effective(1, "appendix", "Appendix")] : [effective()],
    });
    await fixture.user.click(await screen.findByRole("button", { name: "2 artifacts" }));
    let popup = await screen.findByRole("dialog", { name: "Artifacts" });
    expect(within(popup).getAllByRole("button")).toHaveLength(3);
    await fixture.user.click(screen.getByRole("button", { name: /^Child session/ }));
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    popup = await screen.findByRole("dialog", { name: "Artifacts" });
    expect(within(popup).getAllByRole("button")).toHaveLength(2);
    expect(within(popup).getByRole("button", { name: /Family report/ })).toBeDefined();
  });

  it("opens the session's pinned revision in the shared library", async () => {
    const pinned = {
      ...effective(1),
      latestRevision: effective(2).latestRevision,
      link: {
        ...effective(1).link,
        selection: { mode: "pinned" as const, revision: effective(1).revision.metadata.revision },
      },
    };
    using fixture = renderSessionArtifacts({
      effective: async () => [pinned],
      detail: async () => ({
        lineage: reportSummary(),
        links: [pinned.link],
        stableRef: pinned.stableRef,
      }),
    });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(await screen.findByRole("button", { name: /Family report/ }));
    expect(await screen.findByText("Family report content r1")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Selected artifact revision" })).toHaveProperty(
      "value",
      "1",
    );
  });

  it("copies a readable path for the selected revision through the shared library", async () => {
    const materialize = vi.fn<Client["artifacts"]["materialize"]>(async () => ({
      lineageId: "shared",
      title: "Family report",
      kind: "markdown",
      selectedRevision: 2,
      latestRevision: 2,
      digest: effective().revision.metadata.digest,
      linkMode: "follow-latest",
      stableRef: effective().stableRef,
      exactRef: effective().exactRef,
      exactPath: "/cache/shared/revision-2.md",
      files: [],
    }));
    using fixture = renderSessionArtifacts({ materialize });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(await screen.findByRole("button", { name: /Family report/ }));
    expect(await screen.findByText("Shared with workgroup")).toBeDefined();
    expect(screen.getByText("Following latest")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Copy reference" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("cake://artifact/shared"),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Copy exact revision reference" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("cake://artifact/shared@r2"),
    );
    await fixture.user.click(await screen.findByRole("button", { name: "Copy readable path" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("/cache/shared/revision-2.md"),
    );
    expect(materialize).toHaveBeenCalledWith("session-1", "shared", 2, expect.anything());
  });

  it("pins and follows the family link through the shared library, retaining content when link refresh fails", async () => {
    let projection = effective();
    let failNextDetail = false;
    let selections = 0;
    const setSelection = vi.fn<Client["artifacts"]["setSelection"]>(async (input) => {
      projection = { ...projection, link: { ...projection.link, selection: input.selection } };
      failNextDetail = ++selections === 1;
      return projection.link;
    });
    using fixture = renderSessionArtifacts({
      effective: async () => [projection],
      setSelection,
      detail: async () => {
        if (failNextDetail) {
          failNextDetail = false;
          throw new Error("Artifact catalog unavailable");
        }
        return {
          lineage: reportSummary(),
          links: [projection.link],
          stableRef: projection.stableRef,
        };
      },
    });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(await screen.findByRole("button", { name: /Family report/ }));
    await fixture.user.click(await screen.findByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Artifact catalog unavailable")).toBeDefined();
    expect(screen.getByText("Family report content r2")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Pinned r2")).toBeDefined();
    expect(screen.queryByText("Artifact catalog unavailable")).toBeNull();
    expect(screen.getByText("Family report content r2")).toBeDefined();
    expect(setSelection).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        lineageId: "shared",
        target: { type: "family", familyId: "family-1" },
        selection: { mode: "pinned", revision: 2 },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Follow latest" }));
    expect(await screen.findByText("Following latest")).toBeDefined();
    expect(setSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ selection: { mode: "follow-latest" } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("offers the library from an empty popup", async () => {
    using fixture = renderSessionArtifacts({ effective: async () => [] });
    await fixture.user.click(await screen.findByRole("button", { name: "0 artifacts" }));
    expect(await screen.findByText("No artifacts yet.")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Browse all artifacts" }));
    expect(await screen.findByRole("textbox", { name: "Search artifact library" })).toBeDefined();
  });

  it("retries a failed session query on reopening the popup", async () => {
    const load = vi
      .fn<Client["artifacts"]["effective"]>()
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockResolvedValue([effective()]);
    using fixture = renderSessionArtifacts({ effective: load });
    await fixture.user.click(await screen.findByRole("button", { name: "0 artifacts" }));
    expect(await screen.findByText("Catalog unavailable")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "0 artifacts" }));
    await fixture.user.click(screen.getByRole("button", { name: "0 artifacts" }));
    expect(await screen.findByRole("button", { name: /Family report/ })).toBeDefined();
  });

  it("ignores an older initial query after the popup refresh completes", async () => {
    const stale = gate<EffectiveArtifactProjection[]>();
    const load = vi
      .fn<Client["artifacts"]["effective"]>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([effective()]);
    using fixture = renderSessionArtifacts({ effective: load }, [effective()]);
    await fixture.user.click(screen.getByRole("button", { name: "1 artifacts" }));
    expect(await screen.findByRole("button", { name: /Family report/ })).toBeDefined();
    await act(async () => stale.resolve([effective(1, "shared", "Outdated title")]));
    expect(screen.getByRole("button", { name: /Family report/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Outdated title/ })).toBeNull();
  });
});
