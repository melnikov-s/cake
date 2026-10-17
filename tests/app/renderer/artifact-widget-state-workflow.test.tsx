/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import type { WidgetViewCapture } from "../../../src/contracts/widgets/widget-view-evidence";
import { decodeArtifactLineageId } from "../../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactState } from "../../../src/contracts/artifacts/artifact-state";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import userEvent from "@testing-library/user-event";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";

const token = "00000000-0000-4000-8000-000000000010";
const lineageId = decodeArtifactLineageId("editable");
const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: lineageId,
    sessionId: "author-not-viewer",
    revision: 1,
    kind: "widget",
    payload: {
      language: "html",
      source: "<p>Editor</p>",
      brief: "Editor",
      generationSessionId: "private",
      browser: { digest: "b".repeat(64) },
    },
    fallback: { markdown: "Editor fallback" },
  },
  workspacePath: "/project",
  digest: "a".repeat(64),
  createdAt: "",
  updatedAt: "",
};
const request = (
  frame: HTMLIFrameElement,
  type: string,
  value: unknown,
  overrides: { token?: string; source?: Window | null } = {},
) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      source: overrides.source ?? frame.contentWindow,
      data: { source: "cake-inline-widget", token: overrides.token ?? token, type, value },
    }),
  );
afterEach(cleanup);

describe("artifact widget state renderer workflow", () => {
  it("attaches capture pixels and exact provenance to the frozen draft without sending, replacing state, or losing existing text", async () => {
    let finish: ((value: WidgetViewCapture) => void) | undefined;
    const captureWidgetView = vi.fn(
      () =>
        new Promise<WidgetViewCapture>((resolve) => {
          finish = resolve;
        }),
    );
    const stateReplace = vi.fn();
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "viewer", projectPath: "/project" })],
      client: {
        electron: { captureWidgetView },
        inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
        artifacts: {
          stateRead: async () => ({ lineageId, version: 4, value: { variant: "A" } }),
          stateReplace,
        },
      },
    });
    fixture.root.sessionRegistry.load("viewer", "/project");
    applyConversationUpdate(fixture.models.projectConversation("viewer", "/project"), {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "viewer",
        sessionFile: "/sessions/viewer.jsonl",
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
    fixture.root.appShellStore.selectProjectSession("viewer");
    const draft =
      fixture.root.sessionRegistry.findSession("viewer")!.conversationSessionStore.composerStore
        .draftStore;
    draft.setText("Implement C");
    const view = render(
      <ArtifactHost
        record={{ ...record, artifact: { ...record.artifact, revision: 3 } }}
        inlineWidgets={fixture.root.inlineWidgetStore}
        stateSessionId="viewer"
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    act(() => request(frame, "ready", true));
    const user = userEvent.setup();
    await user.click(view.getByRole("button", { name: "Attach current view" }));
    expect(captureWidgetView).toHaveBeenCalledOnce();
    const viewId = view.container
      .querySelector("[data-widget-view-id]")!
      .getAttribute("data-widget-view-id");
    expect(captureWidgetView).toHaveBeenCalledWith(viewId, expect.anything());
    expect(view.getByRole("button", { name: "Capturing…" }).hasAttribute("disabled")).toBe(true);
    // Navigation during native capture must not redirect evidence to another conversation.
    act(() => fixture.root.appShellStore.showSettings());
    await act(async () =>
      finish!({
        exactRef: "cake://artifact/editable@r3",
        provenance: "live-widget-view",
        capturedAt: "2026-01-01T00:00:00.000Z",
        width: 560,
        height: 480,
        data: "Qw==",
        localState: "unavailable: widget-local interactive state is not reported",
        savedState: { lineageId, version: 4, value: { variant: "A" } },
      }),
    );
    expect(draft.text).toBe("Implement C");
    expect(draft.attachments).toHaveLength(2);
    expect(draft.attachments[0]).toMatchObject({ kind: "image", data: "Qw==" });
    expect(draft.attachments[1]).toMatchObject({
      kind: "text",
      text: expect.stringContaining('"exactRef": "cake://artifact/editable@r3"'),
    });
    expect(draft.attachments[1]).toMatchObject({
      text: expect.stringContaining("not a complete or atomic snapshot"),
    });
    expect(stateReplace).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toContain("Send when ready");
  });

  it("hydrates in the hosting linked session, saves via scoped RPC, and pushes external changes without iframe reload", async () => {
    let current: ArtifactState = { lineageId, version: 1, value: { scene: "saved" } };
    const stateRead = vi.fn(async () => current);
    const stateReplace = vi.fn(async (input) => {
      expect(input.sessionId).toBe("viewer");
      expect(input.lineageId).toBe(lineageId);
      expect(input.expectedVersion).toBe(current.version);
      current = { lineageId, version: current.version + 1, value: input.value };
      return current;
    });
    using fixture = createRendererStoreFixture({
      client: {
        inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
        artifacts: { stateRead, stateReplace },
      },
    });
    const view = render(
      <ArtifactHost
        record={record}
        inlineWidgets={fixture.root.inlineWidgetStore}
        stateSessionId="viewer"
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(stateRead).toHaveBeenCalledWith({ sessionId: "viewer", lineageId }, expect.anything());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const src = frame.src;
    act(() => {
      request(frame, "artifact-state-read", { id: "read" });
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "cake-artifact-host",
          token,
          type: "state-result",
          value: { id: "read", ok: true, state: current },
        }),
        "*",
      ),
    );
    act(() => {
      request(frame, "artifact-state-replace", {
        id: "save",
        expectedVersion: 1,
        value: { scene: "edited" },
      });
    });
    await waitFor(() => expect(stateReplace).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "state-result",
          value: { id: "save", ok: true, state: current },
        }),
        "*",
      ),
    );
    current = { lineageId, version: 3, value: { scene: "agent-update" } };
    act(() => fixture.root.inlineWidgetStore.refreshArtifactState(lineageId));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "state", value: current }),
        "*",
      ),
    );
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(frame.src).toBe(src);
    view.unmount();
  });

  it("rejects messages from another frame or token, and reports save failure without retrying the obsolete value", async () => {
    const stateRead = vi.fn(async () => ({ lineageId, version: 1, value: "saved" }));
    const stateReplace = vi.fn(async () => {
      throw new Error("Stale version");
    });
    using fixture = createRendererStoreFixture({
      client: {
        inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
        artifacts: { stateRead, stateReplace },
      },
    });
    const view = render(
      <ArtifactHost
        record={record}
        inlineWidgets={fixture.root.inlineWidgetStore}
        stateSessionId="viewer"
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      request(
        frame,
        "artifact-state-replace",
        { id: "bad-source", expectedVersion: 1, value: "bad" },
        { source: window },
      );
      request(
        frame,
        "artifact-state-replace",
        { id: "bad-token", expectedVersion: 1, value: "bad" },
        { token: "wrong" },
      );
    });
    expect(stateReplace).not.toHaveBeenCalled();
    act(() => {
      request(frame, "artifact-state-replace", {
        id: "malformed",
        expectedVersion: 1,
        value: { elements: [{ customData: undefined }] },
      });
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state-result",
        value: { id: "malformed", ok: false, error: expect.stringContaining("must be JSON") },
      }),
      "*",
    );
    expect(stateReplace).not.toHaveBeenCalled();
    act(() => {
      request(frame, "artifact-state-replace", {
        id: "stale",
        expectedVersion: 0,
        value: "obsolete",
      });
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "state-result",
          value: { id: "stale", ok: false, error: "Stale version" },
        }),
        "*",
      ),
    );
    expect(stateReplace).toHaveBeenCalledOnce();
    expect(stateRead).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("does not grant state access to a global unlinked preview", async () => {
    const stateRead = vi.fn();
    const stateReplace = vi.fn();
    using fixture = createRendererStoreFixture({
      client: {
        inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
        artifacts: { stateRead, stateReplace },
      },
    });
    const view = render(
      <ArtifactHost record={record} inlineWidgets={fixture.root.inlineWidgetStore} />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    act(() => {
      request(frame, "artifact-state-read", { id: "read" });
    });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "state-result",
          value: { id: "read", ok: false, error: "This widget has no linked artifact state scope" },
        }),
        "*",
      ),
    );
    expect(stateRead).not.toHaveBeenCalled();
    expect(stateReplace).not.toHaveBeenCalled();
    view.unmount();
  });
});
