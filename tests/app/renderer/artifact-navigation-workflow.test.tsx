/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import type { Client } from "../../../src/renderer/client/Client";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const token = "00000000-0000-4000-8000-000000000010";
const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: "dashboard",
    sessionId: "creator-not-viewer",
    revision: 1,
    kind: "widget",
    title: "PR dashboard",
    payload: {
      language: "html",
      source: "<p>PRs</p>",
      brief: "PRs",
      browser: { digest: "b".repeat(64) },
    },
    fallback: { markdown: "PRs" },
  },
  workspacePath: "/creator",
  digest: "a".repeat(64),
  createdAt: "",
  updatedAt: "",
};
const options = () => ({
  projects: [projectRecord({ path: "/a", name: "A" }), projectRecord({ path: "/b", name: "B" })],
  sessions: [
    sessionSummary({ sessionId: "a1", projectPath: "/a" }),
    sessionSummary({ sessionId: "a2", projectPath: "/a" }),
    sessionSummary({ sessionId: "b1", projectPath: "/b" }),
  ],
  client: {
    inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
    artifacts: {
      stateRead: async () => ({
        lineageId: decodeArtifactLineageId("dashboard"),
        version: 0,
        value: null,
      }),
    },
  },
});
afterEach(cleanup);

it("projects initial selection and project/session changes through the real Store and frame bridge without reload; unmount removes the subscriber and reopen reads fresh context", async () => {
  const reportViewing = vi.fn<Client["artifacts"]["reportViewing"]>(async () => {});
  const base = options();
  using f = createRendererStoreFixture({
    ...base,
    client: { ...base.client, artifacts: { ...base.client.artifacts, reportViewing } },
  });
  const root = f.root;
  root.projectWorkbenchStore.projectOpenStore.activate("/a");
  root.navigationStore.selectProjectSession("a1");
  const mount = () =>
    render(
      <StoreProvider store={root}>
        <ArtifactHost
          record={record}
          inlineWidgets={root.inlineWidgetStore}
          viewingSurface="library"
        />
      </StoreProvider>,
    );
  const view = mount();
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const src = frame.src;
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          source: "cake-inline-widget",
          token,
          type: "artifact-state-read",
          value: { id: "mount" },
        },
      }),
    );
  });
  const context = (project: object | null, session: object | null) =>
    expect.objectContaining({
      source: "cake-artifact-host",
      token,
      type: "context",
      value: expect.objectContaining({
        windowId: expect.any(String),
        viewId: expect.any(String),
        project,
        session,
      }),
    });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      context({ path: "/a", name: "A" }, { sessionId: "a1", kind: "project-session" }),
      "*",
    ),
  );
  act(() => root.navigationStore.selectProjectSession("a2"));
  await waitFor(() =>
    expect(post).toHaveBeenLastCalledWith(
      context({ path: "/a", name: "A" }, { sessionId: "a2", kind: "project-session" }),
      "*",
    ),
  );
  // Project selection is independent: do not pair B with the retained A session.
  act(() => root.projectWorkbenchStore.projectOpenStore.activate("/b"));
  await waitFor(() =>
    expect(post).toHaveBeenLastCalledWith(context({ path: "/b", name: "B" }, null), "*"),
  );
  act(() => root.navigationStore.selectProjectSession("b1"));
  await waitFor(() =>
    expect(post).toHaveBeenLastCalledWith(
      context({ path: "/b", name: "B" }, { sessionId: "b1", kind: "project-session" }),
      "*",
    ),
  );
  expect(frame.src).toBe(src);
  await waitFor(() =>
    expect(reportViewing).toHaveBeenLastCalledWith(
      expect.objectContaining({
        navigation: expect.objectContaining({
          project: { path: "/b", name: "B" },
          session: { sessionId: "b1", kind: "project-session" },
        }),
      }),
      expect.anything(),
    ),
  );
  view.unmount();
  post.mockClear();
  act(() => root.projectWorkbenchStore.projectOpenStore.activate("/a"));
  expect(post).not.toHaveBeenCalled();
  const reopened = mount();
  await waitFor(() => expect(reopened.container.querySelector("iframe")).not.toBeNull());
  const nextFrame = reopened.container.querySelector("iframe")!;
  const nextPost = vi.spyOn(nextFrame.contentWindow!, "postMessage");
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: nextFrame.contentWindow,
        data: { source: "cake-inline-widget", token, type: "ready", value: true },
      }),
    ),
  );
  await waitFor(() =>
    expect(nextPost).toHaveBeenCalledWith(context({ path: "/a", name: "A" }, null), "*"),
  );
  reopened.unmount();
});

it("keeps global/project chat and cleared selection accurate and isolates window identities", () => {
  using a = createRendererStoreFixture(options());
  using b = createRendererStoreFixture(options());
  const root = a.root;
  const chat = `project-chat:${"a".repeat(64)}`;
  applySnapshot(a.models.cakeChatCatalog, {
    sessions: [{ sessionId: chat, title: "Project A Chat", projectPath: "/a" }],
  });
  root.projectWorkbenchStore.projectOpenStore.activate("/b");
  root.navigationStore.selectProjectSession(chat);
  expect(root.inlineWidgetStore.navigationContext).toMatchObject({
    project: { path: "/a", name: "A" },
    session: { sessionId: chat, kind: "project-chat" },
  });
  root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
  root.appShellStore.selectWorkspace("cake-chat");
  expect(root.inlineWidgetStore.navigationContext).toMatchObject({
    project: null,
    session: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" },
  });
  root.navigationStore.showEmptyWorkbench();
  root.projectWorkbenchStore.projectOpenStore.clear();
  expect(root.inlineWidgetStore.navigationContext).toMatchObject({ project: null, session: null });
  b.root.projectWorkbenchStore.projectOpenStore.activate("/a");
  b.root.navigationStore.selectProjectSession("a2");
  expect(b.root.inlineWidgetStore.navigationContext).toMatchObject({
    project: { path: "/a", name: "A" },
    session: { sessionId: "a2", kind: "project-session" },
  });
  expect(root.inlineWidgetStore.navigationContext?.windowId).not.toBe(
    b.root.inlineWidgetStore.navigationContext?.windowId,
  );
  expect(root.inlineWidgetStore.navigationContext).toMatchObject({ project: null, session: null });
});
