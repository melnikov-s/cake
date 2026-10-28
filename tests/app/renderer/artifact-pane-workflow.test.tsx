/** @vitest-environment jsdom */
import { cleanup, screen, within, waitFor } from "@testing-library/react";
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
import type { TestClientOverrides } from "./test-client";
import type { Client } from "../../../src/renderer/client/Client";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

beforeEach(() => {
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

function renderArtifacts(client: TestClientOverrides = {}) {
  const readExact = vi.fn<Client["artifacts"]["readExact"]>(async (id, value) =>
    revision(id, value),
  );
  const fixture = renderAppShellNavigation({
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
          sessionId === "alpha" ? "alpha" : sessionId === CAKE_CHAT_SESSION_ID ? "cake" : undefined;
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
  });
  return { ...fixture, readExact };
}

const openMenu = async (fixture: ReturnType<typeof renderArtifacts>) => {
  await fixture.user.click(await screen.findByRole("button", { name: "2 artifacts" }));
  return screen.getByRole("dialog", { name: "Artifacts" });
};

describe("Session artifact pane workflow", () => {
  it.each(["alpha", "cake"])(
    "presentation chat sends %s's exact current artifact, clears on exit and isolates conversations",
    async (id) => {
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
        TurnId.make(crypto.randomUUID()),
      );
      using fixture = renderArtifacts({ sessionChats: { prompt } });
      const sessionId = id === "cake" ? CAKE_CHAT_SESSION_ID : "alpha";
      await fixture.user.click(
        screen.getByRole("button", { name: id === "cake" ? "Cake Chat" : /^alpha conversation / }),
      );
      const menu = await openMenu(fixture);
      await fixture.user.click(
        within(menu).getByRole("button", { name: new RegExp(`Report ${id} markdown`) }),
      );
      const pane = await screen.findByRole("complementary", { name: "Artifact" });
      await within(pane).findByText(`${id} body revision 1`);
      const openPresentation = async (artifactId: string) => {
        await fixture.user.click(
          within(pane).getByRole("button", { name: `View Report ${artifactId} fullscreen` }),
        );
        const surface = screen.getByRole("dialog", { name: `Report ${artifactId}` });
        await fixture.user.click(within(surface).getByRole("button", { name: "Open chat" }));
        return surface;
      };
      let surface = await openPresentation(id);
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
      await fixture.user.click(within(surface).getByRole("button", { name: "Close chat" }));
      expect(within(surface).queryByRole("combobox", { name: /^Message/ })).toBeNull();
      expect(within(surface).getByText(`${id} body revision 1`)).toBeDefined();
      await fixture.user.click(
        within(surface).getByRole("button", { name: `Exit fullscreen Report ${id}` }),
      );
      const secondMenu = await openMenu(fixture);
      await fixture.user.click(
        within(secondMenu).getByRole("button", { name: new RegExp(`Report ${id}-second`) }),
      );
      await within(pane).findByText(`${id}-second body revision 1`);
      surface = await openPresentation(`${id}-second`);
      await send(surface, "change this one");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
      expect(prompt.mock.calls[1]![0]).toMatchObject({
        artifactPresentation: { sessionId, artifactId: `${id}-second`, revision: 1 },
      });
      await fixture.user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: `Report ${id}-second` })).toBeNull();
      await fixture.user.click(within(pane).getByRole("button", { name: "Close Artifact" }));
      await send(document.body, "ordinary message");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
      expect(prompt.mock.calls[2]![0].artifactPresentation).toBeNull();
      await fixture.user.click(screen.getByRole("button", { name: /^beta conversation / }));
      await send(document.body, "other conversation");
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(4));
      expect(prompt.mock.calls[3]![0]).toMatchObject({ sessionId: "beta" });
      expect(prompt.mock.calls[3]![0]).not.toHaveProperty("artifactPresentation");
    },
  );

  it.each(["alpha", "cake"])(
    "opens only %s session artifacts in isolation at the pinned revision, then explicitly browses the library",
    async (id) => {
      using fixture = renderArtifacts();
      await fixture.user.click(
        screen.getByRole("button", { name: id === "cake" ? "Cake Chat" : /^alpha conversation / }),
      );
      const menu = await openMenu(fixture);
      expect(within(menu).getAllByRole("button")).toHaveLength(3);
      await fixture.user.click(
        within(menu).getByRole("button", { name: new RegExp(`Report ${id} markdown`) }),
      );
      const pane = await screen.findByRole("complementary", { name: "Artifact" });
      expect(await within(pane).findByText(`${id} body revision 1`)).toBeDefined();
      expect(within(pane).getByText(/Revision 1 of 2/)).toBeDefined();
      expect(screen.queryByRole("textbox", { name: "Search artifact library" })).toBeNull();
      expect(fixture.readExact).toHaveBeenCalledWith(
        id,
        1,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const secondMenu = await openMenu(fixture);
      await fixture.user.click(
        within(secondMenu).getByRole("button", { name: new RegExp(`Report ${id}-second`) }),
      );
      expect(await within(pane).findByText(`${id}-second body revision 1`)).toBeDefined();
      await fixture.user.click(within(pane).getByRole("button", { name: "Close Artifact" }));
      expect(screen.queryByRole("complementary", { name: "Artifact" })).toBeNull();
      const libraryMenu = await openMenu(fixture);
      await fixture.user.click(
        within(libraryMenu).getByRole("button", { name: "Browse all artifacts" }),
      );
      expect(await screen.findByRole("textbox", { name: "Search artifact library" })).toBeDefined();
      expect(screen.getByRole("button", { name: /Report unrelated/ })).toBeDefined();
      await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
      expect(await screen.findByRole("button", { name: "2 artifacts" })).toBeDefined();
    },
  );

  it("closes the isolated viewer on conversation navigation without carrying selection into another session", async () => {
    using fixture = renderArtifacts();
    await fixture.user.click(screen.getByRole("button", { name: /^alpha conversation / }));
    const menu = await openMenu(fixture);
    await fixture.user.click(within(menu).getByRole("button", { name: /Report alpha markdown/ }));
    expect(await screen.findByText("alpha body revision 1")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Cake Chat" }));
    expect(await screen.findByRole("button", { name: "2 artifacts" })).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Artifact" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: /^alpha conversation / }));
    expect(await screen.findByRole("button", { name: "2 artifacts" })).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Artifact" })).toBeNull();
  });
});
