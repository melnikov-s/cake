/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../src/domain/artifacts/artifact-lineage";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
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
      artifacts: {
        effective: async () => [effective()],
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
    });
  }
  fixture.root.appShellStore.selectProjectSession("session-1");
  fixture.root.projectWorkbenchStore.showLoadedSession("session-1");
  fixture.root.sessionLayoutStore.ensureSession("session-1");
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
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

describe("Session artifact workflows", () => {
  it("opens a sole artifact directly, closes it, and reopens its content", async () => {
    using fixture = renderSessionArtifacts();
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    expect(await screen.findByText("Family report content r2")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Session artifacts" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Close Family report" }));
    expect(screen.queryByText("Family report content r2")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "1 artifacts" }));
    expect(await screen.findByText("Family report content r2")).toBeDefined();
  });

  it("shows the shared artifact once in each family session while keeping panel selection session-local", async () => {
    using fixture = renderSessionArtifacts();
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    expect(screen.getByText("Family report content r2")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: /^Child session/ }));
    expect(screen.queryByText("Family report content r2")).toBeNull();
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    expect(screen.getByText("Family report content r2")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "All artifacts" }));
    expect(
      within(screen.getByRole("navigation", { name: "Session artifacts" })).getAllByRole("button"),
    ).toHaveLength(1);
    await fixture.user.click(screen.getByRole("button", { name: /^Parent session/ }));
    expect(screen.getByText("Family report content r2")).toBeDefined();
  });

  it("lists multiple artifacts and navigates between their content without losing the list", async () => {
    using fixture = renderSessionArtifacts({
      effective: async () => [effective(), effective(1, "appendix", "Appendix")],
    });
    await fixture.user.click(await screen.findByRole("button", { name: "2 artifacts" }));
    const list = screen.getByRole("navigation", { name: "Session artifacts" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    await fixture.user.click(within(list).getByRole("button", { name: /Family report/ }));
    expect(screen.getByText("Family report content r2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Previous artifact" })).toHaveProperty(
      "disabled",
      true,
    );
    await fixture.user.click(screen.getByRole("button", { name: "Next artifact" }));
    expect(screen.getByText("Appendix content r1")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next artifact" })).toHaveProperty("disabled", true);
    await fixture.user.click(screen.getByRole("button", { name: "Previous artifact" }));
    expect(screen.getByText("Family report content r2")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "All artifacts" }));
    expect(screen.getByRole("navigation", { name: "Session artifacts" })).toBeDefined();
  });

  it("shows family provenance, copies stable/exact/readable references and pins then follows the session link", async () => {
    let projection = effective();
    const setSelection = vi.fn<Client["artifacts"]["setSelection"]>(async (input) => {
      projection = { ...projection, link: { ...projection.link, selection: input.selection } };
      return projection.link;
    });
    const materialize = vi.fn<Client["artifacts"]["materialize"]>(async () => ({
      lineageId: "shared",
      title: "Family report",
      kind: "markdown",
      selectedRevision: 2,
      latestRevision: 2,
      digest: projection.revision.metadata.digest,
      linkMode: "follow-latest",
      stableRef: projection.stableRef,
      exactRef: projection.exactRef,
      exactPath: "/cache/shared/revision-2.md",
      files: [],
    }));
    using fixture = renderSessionArtifacts({
      effective: async () => [projection],
      setSelection,
      materialize,
    });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(screen.getByRole("button", { name: "Show artifact info" }));
    expect(screen.getByText("Shared with family")).toBeDefined();
    expect(screen.getByText("Following latest")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Copy reference" }));
    expect(await navigator.clipboard.readText()).toBe("cake://artifact/shared");
    await fixture.user.click(screen.getByRole("button", { name: "Copy exact revision reference" }));
    expect(await navigator.clipboard.readText()).toBe("cake://artifact/shared@r2");
    await fixture.user.click(screen.getByRole("button", { name: "Copy readable path" }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("/cache/shared/revision-2.md"),
    );
    expect(materialize).toHaveBeenCalledWith(
      "session-1",
      "shared",
      2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Pinned r2")).toBeDefined();
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
      expect.anything(),
    );
  });

  it("preserves visible content when refreshing the authoritative session projection fails", async () => {
    let projection = effective();
    const load = vi
      .fn<Client["artifacts"]["effective"]>()
      .mockResolvedValueOnce([projection])
      .mockRejectedValueOnce(new Error("Artifact catalog unavailable"))
      .mockImplementation(async () => [projection]);
    const setSelection = vi.fn<Client["artifacts"]["setSelection"]>(async (input) => {
      projection = { ...projection, link: { ...projection.link, selection: input.selection } };
      return projection.link;
    });
    using fixture = renderSessionArtifacts({ effective: load, setSelection });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(screen.getByRole("button", { name: "Show artifact info" }));
    await fixture.user.click(screen.getByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Artifact catalog unavailable")).toBeDefined();
    expect(screen.getByText("Family report content r2")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Pinned r2")).toBeDefined();
    expect(screen.queryByText("Artifact catalog unavailable")).toBeNull();
    expect(screen.getByText("Family report content r2")).toBeDefined();
  });

  it("does not let an older initial load overwrite the projection fetched after pinning", async () => {
    const stale = gate<EffectiveArtifactProjection[]>();
    const initial = effective();
    const pinned = {
      ...initial,
      link: {
        ...initial.link,
        selection: { mode: "pinned" as const, revision: initial.revision.metadata.revision },
      },
    };
    const load = vi
      .fn<Client["artifacts"]["effective"]>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([pinned]);
    using fixture = renderSessionArtifacts(
      { effective: load, setSelection: async () => pinned.link },
      [initial],
    );
    await fixture.user.click(screen.getByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(screen.getByRole("button", { name: "Show artifact info" }));
    await fixture.user.click(screen.getByRole("button", { name: "Pin r2" }));
    expect(await screen.findByText("Pinned r2")).toBeDefined();
    await act(async () => stale.resolve([effective(1, "shared", "Outdated title")]));
    expect(screen.getByText("Pinned r2")).toBeDefined();
    expect(screen.getByText("Family report content r2")).toBeDefined();
    expect(screen.queryByText("Outdated title content r1")).toBeNull();
  });

  it("retries older session history and previews historical content without renaming the artifact list", async () => {
    const latest = effective(52);
    let attempts = 0;
    const history = vi.fn<Client["artifacts"]["history"]>(async ({ offset }) => {
      if (offset === 0)
        return {
          items: Array.from({ length: 50 }, (_, index) => effective(52 - index).revision.metadata),
          offset: 0,
          limit: 50,
          total: 52,
          hasMore: true,
        };
      if (++attempts === 1) throw new Error("History unavailable");
      return {
        items: [3, 2, 1].map((value) => effective(value).revision.metadata),
        offset: 50,
        limit: 50,
        total: 52,
        hasMore: false,
      };
    });
    using fixture = renderSessionArtifacts({
      effective: async () => [latest],
      history,
      readExact: async (_id, revision) =>
        effective(revision, "shared", "Historical draft").revision,
    });
    await fixture.user.click(await screen.findByRole("button", { name: "1 artifacts" }));
    await fixture.user.click(screen.getByRole("button", { name: "Show artifact info" }));
    const revisions = screen.getByRole("combobox", { name: "View artifact revision" });
    expect(within(revisions).getAllByRole("option")).toHaveLength(50);
    await fixture.user.click(screen.getByRole("button", { name: "Load older revisions" }));
    expect(await screen.findByText("History unavailable")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Retry revision history" }));
    await waitFor(() => expect(within(revisions).getAllByRole("option")).toHaveLength(52));
    expect(screen.queryByText("History unavailable")).toBeNull();
    await fixture.user.selectOptions(revisions, "1");
    expect(await screen.findByText("Historical draft content r1")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Copy exact revision reference" }));
    expect(await navigator.clipboard.readText()).toBe("cake://artifact/shared@r1");
    await fixture.user.click(screen.getByRole("button", { name: "All artifacts" }));
    expect(
      within(screen.getByRole("navigation", { name: "Session artifacts" })).getByRole("button", {
        name: /Family report/,
      }),
    ).toBeDefined();
  });
});
