/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubagentHandleId } from "../../../src/contracts/subagents/subagent-data";
import { nestedTranscriptBehaviorFor } from "../../../src/renderer/lib/nested-transcript-behavior";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";
import { workerActivity } from "./subagent-activity-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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
  vi.unstubAllGlobals();
});

const timestamp = new Date(0).toISOString();
function thread(parentSessionId: string, id: string, sidecarSessionId: string, title: string) {
  const value = ReviewThread.create({
    parentSessionId,
    id,
    sidecarSessionId,
    workingDirectory: "/alpha",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  value.anchor = { ...value.anchor, view: "session", selectedText: title };
  return value;
}

/** Authority updates are controlled at the projection boundary. Real backend launch evidence is a separate native workflow. */
it("opens actual nested discussion/retained-worker parts, preserving the public owner chain and a writable discussion draft", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"], transcriptViewport: true });
  const outer = thread("alpha", "outer-thread", "outer-sidecar", "Outer discussion");
  const inner = thread("outer-sidecar", "inner-thread", "inner-sidecar", "Inner discussion");
  act(() => {
    for (const value of [outer, inner]) {
      const catalog = fixture.models.discussionCatalog(value.parentSessionId);
      catalog.metadataLoaded = true;
      catalog.metadata.push({
        id: value.id,
        parentSessionId: value.parentSessionId,
        sidecarSessionId: value.sidecarSessionId,
        workingDirectory: value.workingDirectory,
        title: value.anchor.selectedText,
        running: false,
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });
  let opening!: Promise<void>;
  await act(async () => {
    opening = fixture.root.navigationStore.openConversationTarget({
      kind: "side-chat",
      sessionId: "inner-sidecar",
      parentSessionId: "outer-sidecar",
      threadId: "inner-thread",
    });
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(
      fixture.root.discussionNavigationStore.ownerTargets.map((target) => target.sessionId),
    ).toEqual(["outer-sidecar", "inner-sidecar"]),
  );
  await act(async () => {
    fixture.models.discussionCatalog("alpha").threads.push(outer);
    fixture.models.discussionCatalog("outer-sidecar").threads.push(inner);
    fixture.root.discussionNavigationStore
      .session("inner-sidecar")!
      .chatStore.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    await opening;
  });
  const nested = fixture.root.discussionNavigationStore.session("inner-sidecar")!;
  act(() =>
    applyConversationUpdate(nested.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "inner-sidecar",
        sessionFile: "/reviews/inner-sidecar.jsonl",
        parts: [
          {
            id: "inner-answer",
            kind: "text",
            role: "assistant",
            text: "Actual nested discussion assistant body",
            status: "complete",
          },
        ],
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
    }),
  );
  expect(
    nested.chatStore.parts.some(
      (part) => part.kind === "text" && part.text === "Actual nested discussion assistant body",
    ),
  ).toBe(true);
  expect(document.querySelector('[data-slot="focused-secondary-conversation"]')).not.toBeNull();
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="focused-secondary-conversation"]')?.textContent,
    ).toContain("Actual nested discussion assistant body"),
  );
  const breadcrumb = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
  expect(breadcrumb.getByRole("button", { name: "Outer discussion" })).toBeTruthy();
  expect(
    breadcrumb.getByRole("button", { name: "Inner discussion" }).getAttribute("aria-current"),
  ).toBe("page");
  expect(nestedTranscriptBehaviorFor(fixture.root, nested.chatStore)).toMatchObject({
    workspacePath: "/alpha",
    messageReferenceSessionId: "inner-sidecar",
  });
  const composer = screen.getByRole("combobox", { name: "Reply to side chat" });
  await fixture.user.type(composer, "Retained nested draft");
  const state = () =>
    fixture.root.applicationControlStore.invoke({ name: "app.state", arguments: {} });
  expect(await state()).toMatchObject({
    state: {
      focusedConversation: {
        sessionId: "alpha",
        target: {
          kind: "side-chat",
          sessionId: "inner-sidecar",
          parentSessionId: "outer-sidecar",
          threadId: "inner-thread",
        },
      },
    },
  });
  await fixture.user.click(breadcrumb.getByRole("button", { name: "alpha conversation" }));
  await act(async () => {
    await fixture.root.navigationStore.openConversationTarget({
      kind: "side-chat",
      sessionId: "inner-sidecar",
      parentSessionId: "outer-sidecar",
      threadId: "inner-thread",
    });
  });
  expect(fixture.root.discussionNavigationStore.session("inner-sidecar")).toBe(nested);
  expect(await screen.findByRole("combobox", { name: "Reply to side chat" })).toHaveProperty(
    "value",
    "Retained nested draft",
  );
  expect(await screen.findByText("Actual nested discussion assistant body")).toBeTruthy();

  const handleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000001");
  act(() => {
    const catalog = fixture.models.subagentCatalog("outer-sidecar");
    catalog.metadataLoaded = true;
    catalog.metadata.push({
      parentSessionId: "outer-sidecar",
      handleId,
      anchorPartId: "spawn",
      task: "Retained nested worker",
      status: "complete",
      streaming: false,
      released: true,
    });
  });
  await act(async () => {
    opening = fixture.root.navigationStore.openConversationTarget({
      kind: "subagent",
      sessionId: "outer-sidecar",
      handleId,
    });
    await Promise.resolve();
  });
  await act(async () => {
    applySubagentUpdate(fixture.models.subagentCatalog("outer-sidecar"), "outer-sidecar", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "outer-sidecar",
      backgroundActive: false,
      activities: [
        workerActivity({
          parentSessionId: "outer-sidecar",
          handleId,
          task: "Retained nested worker",
          projectPath: "/alpha",
          status: "complete",
          streaming: false,
          released: true,
          parts: [
            {
              id: "worker-answer",
              kind: "text",
              role: "assistant",
              text: "Actual retained nested worker body",
              status: "complete",
            },
          ],
        }),
      ],
    });
    fixture.root.discussionNavigationStore.subagents
      .find((workers) => workers.parentSessionId === "outer-sidecar")!
      .chatStore(handleId)!
      .transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    await opening;
  });
  const retainedWorker = fixture.root.discussionNavigationStore.subagents
    .find((workers) => workers.parentSessionId === "outer-sidecar")!
    .chatStore(handleId)!;
  expect(nestedTranscriptBehaviorFor(fixture.root, retainedWorker)).toMatchObject({
    workspacePath: "/alpha",
  });
  expect(await screen.findByText("Actual retained nested worker body")).toBeTruthy();
  expect(await state()).toMatchObject({
    state: {
      focusedConversation: {
        sessionId: "alpha",
        target: {
          kind: "subagent",
          sessionId: "outer-sidecar",
          handleId,
          title: "Retained nested worker",
        },
      },
    },
  });
  const workerBreadcrumb = within(
    screen.getByRole("navigation", { name: "Conversation breadcrumb" }),
  );
  expect(workerBreadcrumb.getByRole("button", { name: "Outer discussion" })).toBeTruthy();
  expect(
    workerBreadcrumb
      .getByRole("button", { name: "Retained nested worker" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(
    fixture.root.discussionNavigationStore.session("inner-sidecar")!.conversationSessionStore
      .composerStore.draftStore.text,
  ).toBe("Retained nested draft");
});
