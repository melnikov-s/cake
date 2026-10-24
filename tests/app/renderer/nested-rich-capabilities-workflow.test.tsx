/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRevision } from "../../../src/contracts/artifacts/artifact-lineage";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { TaskInputReference } from "../../../src/contracts/conversations/task-input";
import type { Client } from "../../../src/renderer/client/Client";
import { artifactRevision, referenceMetadata } from "./artifact-reference-workflow-fixture";
import {
  editorLease,
  editorSessionId,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";

const reference: TaskInputReference = {
  kind: "input",
  id: "4a3d9c1e-5b2f-4c8a-9e7d-6f1a2b3c4d5e",
  name: "sidecar.png",
  mimeType: "image/png",
  byteLength: 68,
};
const thread: DiscussionThread = {
  id: "rich-thread",
  parentSessionId: editorSessionId,
  sidecarSessionId: "rich-sidecar",
  workingDirectory: "/project",
  anchor: {
    path: `session:${editorSessionId}`,
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
      id: "image",
      kind: "attachment",
      attachmentKind: "image",
      role: "user",
      name: reference.name,
      mediaType: "image/png",
      inputReference: reference,
    },
    {
      id: "widget-publication",
      kind: "tool",
      name: "cake",
      command: "artifacts.present",
      input: "",
      state: "success",
      artifactId: "widget",
      artifactReference: "cake://artifact/widget@r1",
    },
    {
      id: "source",
      kind: "attachment",
      attachmentKind: "source",
      role: "user",
      name: "src/main.ts",
      mediaType: "text/plain",
      location: { path: "src/main.ts", range: { start: { line: 0 } } },
    },
    {
      id: "publication",
      kind: "tool",
      name: "cake",
      command: "artifacts.present",
      input: "",
      state: "success",
      artifactId: "report",
      artifactReference: "cake://artifact/report@r1",
    },
  ],
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
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
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// The real App selects ConversationSplitLayout, IdeWorkspace and BrowserWorkspace.
// Service payload/renderer contracts only: jsdom does not prove native image decoding or focus.
describe("nested rich capabilities across production hosts", () => {
  it("retains sidecar-authorized image pixels and rich artifact publications through normal, IDE and Browser modes", async () => {
    const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(async () => ({
      kind: "image",
      reference,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=",
    }));
    const stateRead = vi.fn<Client["artifacts"]["stateRead"]>(async ({ lineageId }) => ({
      lineageId,
      version: 1,
      value: {},
    }));
    const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
      outcome: { view: "file" },
      locations: [],
    }));
    const token = "00000000-0000-4000-8000-000000000010";
    using fixture = renderEmbeddedEditor(
      {
        sessionChats: { readAttachment },
        vscode: { open: async () => editorLease("a"), reveal },
        inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
        browser: {
          open: async () => ({
            sessionId: editorSessionId,
            url: "https://example.com",
            title: "Example",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            inspecting: false,
          }),
          updateBounds: async () => ({
            sessionId: editorSessionId,
            url: "https://example.com",
            title: "Example",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            inspecting: false,
          }),
        },
        artifacts: {
          referenceMetadata: async (ref) => referenceMetadata(ref),
          readExact: async (id, revision): Promise<ArtifactRevision> => {
            const original = artifactRevision(id, revision);
            return id !== "widget"
              ? original
              : {
                  ...original,
                  metadata: { ...original.metadata, kind: "widget" },
                  snapshot: {
                    protocol: "cake.artifact/v1",
                    id,
                    sessionId: "publisher",
                    revision,
                    title: "Interactive child",
                    kind: "widget",
                    payload: {
                      language: "html",
                      source: "<p>Interactive child</p>",
                      brief: "Interactive child",
                      generationSessionId: "generation",
                      browser: { digest: "b".repeat(64) },
                    },
                    fallback: { markdown: "Widget fallback" },
                  },
                };
          },
          stateRead,
        },
      },
      { threads: [thread] },
    );
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(
      within(screen.getByRole("dialog", { name: "Open side chats" })).getByRole("button"),
    );
    const assertRichPanel = async () => {
      const panel = within(await screen.findByRole("complementary", { name: "Side chat" }));
      expect((await panel.findByRole("img", { name: reference.name })).getAttribute("src")).toBe(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=",
      );
      expect(await panel.findByText("report content r1")).toBeDefined();
      expect(panel.getByRole("button", { name: /Quarterly report Collapse/ })).toBeDefined();
      expect(panel.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
      expect(await panel.findByTitle("Interactive child")).toBeDefined();
      expect(panel.getByRole("button", { name: "Open src/main.ts:1" })).toBeDefined();
    };
    await assertRichPanel();
    expect(readAttachment).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "rich-sidecar", reference: reference.id },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    await assertRichPanel();
    await fixture.user.click(screen.getByRole("button", { name: "Open Browser Mode" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Browser address" })).toBeDefined(),
    );
    await assertRichPanel();
    await fixture.user.click(screen.getByRole("button", { name: "Back to agent" }));
    await assertRichPanel();
    expect(readAttachment).toHaveBeenCalledTimes(1);
    expect(stateRead.mock.calls.length).toBeGreaterThan(0);
    expect(stateRead.mock.calls.every(([input]) => input.sessionId === "rich-sidecar")).toBe(true);
    const panel = within(screen.getByRole("complementary", { name: "Side chat" }));
    await fixture.user.click(panel.getByRole("button", { name: "Open src/main.ts:1" }));
    await waitFor(() =>
      expect(reveal).toHaveBeenCalledWith(
        "/project",
        expect.objectContaining({ path: "src/main.ts" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });
});
