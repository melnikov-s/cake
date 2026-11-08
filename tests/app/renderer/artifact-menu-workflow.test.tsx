/** @vitest-environment jsdom */
import { act, cleanup, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ArtifactDigest,
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  formatArtifactRef,
  type ArtifactLineageSummary,
  type ArtifactRevision,
  type EffectiveArtifactProjection,
} from "../../../src/contracts/artifacts/artifact-lineage";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type {
  CaptureCompletion,
  CaptureDestination,
} from "../../../src/contracts/desktop/screen-capture-data";
import type { TestClientOverrides } from "./test-client";
import type { Client } from "../../../src/renderer/client/Client";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { applyDiscussionSessionUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

beforeEach(() => {
  // jsdom adapter only; Electron verifies atomic iframe moves.
  Object.defineProperty(Element.prototype, "moveBefore", {
    configurable: true,
    value(this: Element, node: Node, child: Node | null) {
      this.insertBefore(node, child);
    },
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: media === "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  Reflect.deleteProperty(Element.prototype, "moveBefore");
  vi.unstubAllGlobals();
});

const revision = (id: string, value: number): ArtifactRevision => ({
  lineageId: decodeArtifactLineageId(id),
  metadata: {
    revision: decodeArtifactRevisionNumber(value),
    digest: Schema.decodeUnknownSync(ArtifactDigest)("a".repeat(64)),
    kind: "markdown",
    publishedAt: new Date(Date.UTC(2026, 0, value)).toISOString(),
    publishedBySessionId: "author",
    workingDirectory: "/alpha",
  },
  snapshot: {
    protocol: "cake.artifact/v1",
    id,
    sessionId: "author",
    revision: value,
    title: `Report ${id}`,
    kind: "markdown",
    payload: { markdown: `${id} body revision ${value}` },
    fallback: { markdown: `${id} body revision ${value}` },
  },
});
const summary = (id: string): ArtifactLineageSummary => ({
  id: decodeArtifactLineageId(id),
  global: false,
  title: `Report ${id}`,
  createdAt: revision(id, 1).metadata.publishedAt,
  latestRevision: decodeArtifactRevisionNumber(2),
  latest: revision(id, 2).metadata,
  stableRef: formatArtifactRef({ lineageId: decodeArtifactLineageId(id) }),
});
const effective = (sessionId: string, id: string): EffectiveArtifactProjection => ({
  revision: revision(id, 1),
  latestRevision: decodeArtifactRevisionNumber(2),
  stableRef: summary(id).stableRef,
  exactRef: formatArtifactRef({
    lineageId: decodeArtifactLineageId(id),
    revision: decodeArtifactRevisionNumber(1),
  }),
  link: {
    lineageId: decodeArtifactLineageId(id),
    target: { type: "session", sessionId },
    selection: { mode: "pinned", revision: decodeArtifactRevisionNumber(1) },
    createdAt: revision(id, 1).metadata.publishedAt,
  },
});

function renderArtifacts(
  client: TestClientOverrides = {},
  options?: Parameters<typeof renderAppShellNavigation>[1],
) {
  const readExact = vi.fn<Client["artifacts"]["readExact"]>(async (id, value) =>
    revision(id, value),
  );
  const fixture = renderAppShellNavigation(
    {
      ...client,
      electron: { setFullscreenSurfaceOpen: async () => undefined, ...client.electron },
      artifacts: {
        catalog: async () => ({
          items: [summary("alpha"), summary("cake"), summary("unrelated")],
          offset: 0,
          limit: 50,
          total: 3,
          hasMore: false,
        }),
        effective: async (sessionId) => {
          const id =
            sessionId === "alpha"
              ? "alpha"
              : sessionId === CAKE_CHAT_SESSION_ID
                ? "cake"
                : undefined;
          return id ? [effective(sessionId, id), effective(sessionId, `${id}-second`)] : [];
        },
        detail: async (id) => ({
          lineage: summary(id),
          links:
            id.startsWith("alpha") || id.startsWith("cake")
              ? [
                  {
                    ...effective(id.startsWith("cake") ? CAKE_CHAT_SESSION_ID : "alpha", id).link,
                    id: `link-${id}`,
                  },
                ]
              : [],
          stableRef: summary(id).stableRef,
        }),
        history: async ({ lineageId }) => ({
          items: [revision(lineageId, 2).metadata, revision(lineageId, 1).metadata],
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false,
        }),
        readExact,
      },
    },
    options,
  );
  return { ...fixture, readExact };
}

const chooseConversation = async (fixture: ReturnType<typeof renderArtifacts>, id: string) => {
  if (id === "cake")
    await fixture.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
  else {
    await fixture.user.click(screen.getByRole("button", { name: "Search sessions" }));
    await fixture.user.click(
      screen.getByRole("option", { name: new RegExp(`^${id} conversation `) }),
    );
  }
};

const openMenu = async (fixture: ReturnType<typeof renderArtifacts>, ownerLabel?: string) => {
  const trigger = await screen.findByRole("button", {
    name: `2 artifacts${ownerLabel ? ` for ${ownerLabel}` : ""}`,
  });
  expect(within(trigger).getByText("2").classList.contains("bg-card")).toBe(true);
  await fixture.user.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return screen.getByRole("dialog", {
    name: ownerLabel ? `Artifacts for ${ownerLabel}` : "Artifacts",
  });
};

const capturePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

describe("Artifact accessory workflow", () => {
  it.each(["same", "different", "cake", "cancel", "failure", "full"] as const)(
    "returns a fullscreen snapshot to its exact receiving chat: %s",
    async (outcome) => {
      let complete!: (value: CaptureCompletion) => void;
      let fail!: (error: Error) => void;
      const target: CaptureDestination =
        outcome === "cake"
          ? { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID }
          : { kind: "project-session", sessionId: outcome === "same" ? "alpha" : "beta" };
      using fixture = renderArtifacts(
        {
          electron: {
            startScreenCapture: () =>
              new Promise((resolve, reject) => {
                complete = resolve;
                fail = reject;
              }),
          },
        },
        { history: ["alpha"] },
      );
      const draft = (
        target.kind === "cake-chat"
          ? fixture.root.cakeChatCollectionStore.registry.find(target.sessionId)!
          : fixture.root.sessionRegistry.findSession(target.sessionId)!
      ).conversationSessionStore.composerStore.draftStore;
      const existing = Array.from({ length: outcome === "full" ? 20 : 1 }, (_, index) => ({
        kind: "file" as const,
        name: `keep-${index}.txt`,
        path: `/keep-${index}.txt`,
      }));
      act(() => {
        draft.setText("Receiving draft");
        draft.appendAttachments(existing);
      });
      const menu = await openMenu(fixture);
      await fixture.user.click(
        within(menu).getByRole("button", { name: /^Report alpha markdown/ }),
      );
      const pane = await screen.findByRole("complementary", { name: "Report alpha" });
      await fixture.user.click(
        within(pane).getByRole("button", { name: "View Report alpha fullscreen" }),
      );
      await screen.findByRole("dialog", { name: "Report alpha" });
      // Native shortcut enters this Store directly; there is no capture button in the presentation.
      let capturing!: Promise<void>;
      act(() => {
        capturing = fixture.root.screenCaptureStore.capture();
      });
      expect(screen.getByRole("dialog", { name: "Report alpha" })).toBeDefined();
      expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
      await act(async () => {
        if (outcome === "failure") fail(new Error("Capture failed"));
        else
          complete({
            annotationColor: "pink",
            ...(outcome === "cancel"
              ? {}
              : {
                  capture: {
                    data: capturePng,
                    annotationText: "Look at the heading",
                    destination: target,
                  },
                }),
          });
        await capturing;
      });
      if (["cancel", "failure", "full"].includes(outcome)) {
        expect(screen.getByRole("dialog", { name: "Report alpha" })).toBeDefined();
        expect(fixture.root.appShellStore.activeConversation?.sessionId).toBe("alpha");
        expect(draft.text).toBe("Receiving draft");
        expect(draft.attachments).toEqual(existing);
      } else {
        expect(screen.queryByRole("dialog", { name: "Report alpha" })).toBeNull();
        expect(fixture.root.appShellStore.activeConversation).toEqual(target);
        expect(fixture.root.workspaceNavigatorStore.companionTab).toBe("chat");
        expect(draft.attachments).toEqual([
          ...existing,
          expect.objectContaining({ kind: "image", data: capturePng }),
        ]);
        expect(draft.text).toMatch(
          /^Receiving draft\n\n[a-z0-9]{3}\.png\nSnapshot of cake:\/\/artifact\/alpha@r1\nLook at the heading$/,
        );
        expect(screen.getByRole("combobox", { name: /^Message/ })).toBeDefined();
      }
    },
  );

  it.each(["alpha", "cake"])(
    "opens %s's pinned artifact in the shared pane, expands and returns with exact chat context",
    async (id) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make(crypto.randomUUID()),
      );
      using fixture = renderArtifacts({ sessionChats: { prompt } });
      const sessionId = id === "cake" ? CAKE_CHAT_SESSION_ID : "alpha";
      await chooseConversation(fixture, id);
      const menu = await openMenu(fixture);
      expect(within(menu).getAllByRole("button")).toHaveLength(3);
      await fixture.user.click(
        within(menu).getByRole("button", { name: new RegExp(`Report ${id} markdown`) }),
      );
      const pane = await screen.findByRole("complementary", { name: `Report ${id}` });
      expect(await within(pane).findByText(`${id} body revision 1`)).toBeDefined();
      expect(screen.queryByRole("dialog", { name: `Report ${id}` })).toBeNull();
      await fixture.user.click(
        within(pane).getByRole("button", { name: `View Report ${id} fullscreen` }),
      );
      const surface = await screen.findByRole("dialog", { name: `Report ${id}` });
      expect(screen.queryByRole("dialog", { name: "Artifacts" })).toBeNull();
      expect(screen.queryByRole("textbox", { name: "Search artifact library" })).toBeNull();
      expect(fixture.readExact).toHaveBeenCalledWith(
        id,
        1,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await fixture.user.click(within(surface).getByRole("button", { name: "Open chat" }));
      const send = async (container: HTMLElement, text: string) => {
        const input = within(container).getByRole("combobox", { name: /^Message/ });
        await fixture.user.type(input, `${text}{Enter}`);
      };
      await send(surface, "edit it");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      expect(prompt.mock.calls[0]![0]).toMatchObject({
        sessionId,
        text: "edit it",
        artifactPresentation: { sessionId, artifactId: id, revision: 1 },
      });
      await send(surface, "keep editing it");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(prompt.mock.calls[1]![0]).toMatchObject({
        artifactPresentation: { sessionId, artifactId: id, revision: 1 },
      });
      await fixture.user.click(within(surface).getByRole("button", { name: "Close chat" }));
      expect(within(surface).queryByRole("combobox", { name: /^Message/ })).toBeNull();
      expect(within(surface).getByText(`${id} body revision 1`)).toBeDefined();
      await fixture.user.click(
        within(surface).getByRole("button", { name: `Exit fullscreen Report ${id}` }),
      );
      expect(within(pane).getByText(`${id} body revision 1`)).toBeDefined();
      // Expanding/returning and selecting another artifact never sends by itself.
      expect(prompt).toHaveBeenCalledTimes(2);
      const secondMenu = await openMenu(fixture);
      await fixture.user.click(
        within(secondMenu).getByRole("button", { name: new RegExp(`Report ${id}-second`) }),
      );
      const second = await screen.findByRole("complementary", { name: `Report ${id}-second` });
      expect(await within(second).findByText(`${id}-second body revision 1`)).toBeDefined();
      expect(prompt).toHaveBeenCalledTimes(2);
      await send(document.body, "change this one");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
      expect(prompt.mock.calls[2]![0]).toMatchObject({
        artifactPresentation: { sessionId, artifactId: `${id}-second`, revision: 1 },
      });
      await fixture.user.click(
        within(second).getByRole("button", { name: `Close Report ${id}-second` }),
      );
      expect(screen.queryByRole("complementary", { name: `Report ${id}-second` })).toBeNull();
      expect(prompt).toHaveBeenCalledTimes(3);
      await send(document.body, "ordinary message");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(4));
      expect(prompt.mock.calls[3]![0].artifactPresentation).toBeNull();
      await chooseConversation(fixture, "beta");
      await send(document.body, "other conversation");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(5));
      expect(prompt.mock.calls[4]![0]).toMatchObject({ sessionId: "beta" });
      expect(prompt.mock.calls[4]![0].artifactPresentation).toBeNull();
    },
  );

  it("replaces side chat with an artifact and reopens the same side chat draft from its menu", async () => {
    using fixture = renderArtifacts({}, { history: ["alpha"] });
    const thread: DiscussionThread = {
      id: "discussion",
      sidecarSessionId: "sidecar",
      parentSessionId: "alpha",
      workingDirectory: "/alpha",
      status: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      anchor: {
        path: "session:alpha",
        view: "session",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      parts: [
        {
          id: "question",
          kind: "text",
          role: "user",
          text: "Review the report",
          status: "complete",
        },
      ],
    };
    await act(async () => {
      applyDiscussionSessionUpdate(
        fixture.models.discussionConversation("sidecar", "/alpha"),
        "sidecar",
        {
          _tag: "Snapshot",
          revision: 1,
          snapshot: {
            identity: { _tag: "DiscussionSession", sessionId: "sidecar", parentSessionId: "alpha" },
            conversation: {
              sessionId: "sidecar",
              sessionFile: "/sessions/sidecar",
              parts: thread.parts,
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
        },
      );
      applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("alpha"), "alpha", {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: "alpha",
        threads: [thread],
      });
    });
    const openSideChat = async () => {
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
      await fixture.user.click(screen.getByRole("button", { name: /Review the report/ }));
      return screen.getByRole("combobox", { name: "Reply to side chat" });
    };
    const chat = await openSideChat();
    await fixture.user.type(chat, "Keep this draft");
    expect(screen.getByRole("button", { name: /^Review changes in \/alpha/ })).toBeDefined();
    const menu = await openMenu(fixture, "alpha conversation");
    expect(within(menu).getByText("Artifacts for alpha conversation")).toBeDefined();
    await fixture.user.click(within(menu).getByRole("button", { name: /Report alpha markdown/ }));
    expect(await screen.findByRole("complementary", { name: "Report alpha" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Reply to side chat" })).toBeNull();
    const reopened = await openSideChat();
    expect(reopened).toHaveProperty("value", "Keep this draft");
    expect(screen.queryByRole("complementary", { name: "Report alpha" })).toBeNull();
  });

  it.each(["alpha", "cake"])("keeps %s's explicit library-browsing action", async (id) => {
    using fixture = renderArtifacts();
    await chooseConversation(fixture, id);
    const menu = await openMenu(fixture);
    await fixture.user.click(within(menu).getByRole("button", { name: "Browse all artifacts" }));
    expect(await screen.findByRole("textbox", { name: "Search artifact library" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Report unrelated/ })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    expect(await screen.findByRole("button", { name: "2 artifacts" })).toBeDefined();
  });

  it.each(["alpha", "cake"])(
    "opening and closing %s's artifact without sending only captures an outside candidate",
    async (id) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make(crypto.randomUUID()),
      );
      using fixture = renderArtifacts({ sessionChats: { prompt } });
      const sessionId = id === "cake" ? CAKE_CHAT_SESSION_ID : "alpha";
      await chooseConversation(fixture, id);
      const menu = await openMenu(fixture);
      await fixture.user.click(
        within(menu).getByRole("button", { name: new RegExp(`Report ${id} markdown`) }),
      );
      const surface = await screen.findByRole("complementary", { name: `Report ${id}` });
      await fixture.user.click(within(surface).getByRole("button", { name: `Close Report ${id}` }));
      expect(prompt).not.toHaveBeenCalled();
      // Only the backend's sent history can decide whether this candidate clears a target.
      const input = await screen.findByRole("combobox", { name: /^Message/ });
      await fixture.user.type(input, "a new topic{Enter}");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      expect(prompt.mock.calls[0]![0]).toMatchObject({
        sessionId,
        text: "a new topic",
        artifactPresentation: null,
      });
    },
  );

  it("opens the library directly from the rail, preserving filters, artifact selection and the retained conversation", async () => {
    using fixture = renderArtifacts();
    const original = fixture.root.appShellStore.activeConversation;
    await fixture.user.click(
      within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
        "button",
        { name: "Settings" },
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await fixture.user.click(
      within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
        "button",
        { name: "Artifacts" },
      ),
    );
    const search = await screen.findByRole("textbox", { name: "Search artifact library" });
    expect(screen.queryByRole("dialog", { name: "Artifacts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse all artifacts" })).toBeNull();
    await fixture.user.type(search, "unrelated{Enter}");
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Filter artifacts by kind" }),
      "markdown",
    );
    await fixture.user.click(await screen.findByRole("button", { name: /Report unrelated/ }));
    expect(await screen.findByText("unrelated body revision 2")).toBeDefined();
    expect(fixture.readExact).toHaveBeenCalledWith("unrelated", 2, expect.anything());
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    expect(fixture.root.appShellStore.activeConversation).toEqual(original);
    await fixture.user.click(
      within(screen.getByRole("navigation", { name: "Projects and global utilities" })).getByRole(
        "button",
        { name: "Artifacts" },
      ),
    );
    expect(await screen.findByRole("textbox", { name: "Search artifact library" })).toHaveProperty(
      "value",
      "unrelated",
    );
    expect(screen.getByRole("combobox", { name: "Filter artifacts by kind" })).toHaveProperty(
      "value",
      "markdown",
    );
    expect(await screen.findByText("unrelated body revision 2")).toBeDefined();
  });

  it("closes the artifact pane on conversation navigation without carrying selection into another session", async () => {
    using fixture = renderArtifacts();
    await chooseConversation(fixture, "alpha");
    const menu = await openMenu(fixture);
    await fixture.user.click(within(menu).getByRole("button", { name: /Report alpha markdown/ }));
    const surface = await screen.findByRole("complementary", { name: "Report alpha" });
    expect(await within(surface).findByText("alpha body revision 1")).toBeDefined();
    // Cross-conversation navigation can also originate in fullscreen side chat.
    await fixture.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
    expect(await screen.findByRole("button", { name: "2 artifacts" })).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Report alpha" })).toBeNull();
  });
});
