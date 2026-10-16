/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
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

function renderArtifacts() {
  const readExact = vi.fn<Client["artifacts"]["readExact"]>(async (id, value) =>
    revision(id, value),
  );
  const fixture = renderAppShellNavigation({
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
      detail: async (id) => ({ lineage: summary(id), links: [], stableRef: summary(id).stableRef }),
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
