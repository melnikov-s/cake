/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it } from "vitest";
import { Schema } from "effect";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import { uiPartSchema } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createCakeSessionRuntimeEventProjection } from "../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import {
  nestedArgumentBytes,
  nestedEntries,
  nestedScript,
} from "../../fixtures/nested-tool-activity";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it("renders live nested events and metadata-only saved history in the real project Chat workflow", async () => {
  using fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "nested", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("nested", "/project");
  fixture.root.appShellStore.selectProjectSession("nested");
  fixture.root.projectWorkbenchStore.showLoadedSession("nested");
  const model = fixture.models.projectConversation("nested", "/project");
  let revision = 1;
  const snapshot: ConversationSnapshot = {
    sessionId: "nested",
    sessionFile: "/project/nested.jsonl",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: true,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  applyConversationUpdate(model, { _tag: "Snapshot", revision, snapshot });
  // Pi is the only external boundary. The real adapter/schema/reducer and real
  // Root/Conversation/ChatStore deliver activity to the authoritative Chat.
  const pi = {
    sessionManager: { getHeader: () => undefined },
    systemPrompt: "",
    agent: { state: { tools: [] } },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
  } as unknown as AgentSession;
  const projection = createCakeSessionRuntimeEventProjection({
    session: pi,
    sessionId: "nested",
    compactionQueuedMessages: () => [],
    isDisposed: () => false,
    emit: (event) => {
      if (event.type !== "part-updated") return;
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: ++revision,
        event: {
          _tag: "PartUpdated",
          sessionId: "nested",
          part: Schema.decodeUnknownSync(uiPartSchema)(event.part),
        },
      });
    },
  });
  // jsdom cannot settle Virtuoso's initial bottom alignment. Start at the top, as in
  // session-artifacts-workflow; this case verifies tool content, not native scrolling.
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
    </VirtuosoMockContext.Provider>,
  );
  const user = userEvent.setup();
  try {
    await act(async () => {
      projection.projectEvent({
        type: "tool_execution_start",
        toolCallId: "script",
        toolName: "codemode",
        args: { code: nestedScript },
      });
      projection.projectEvent({
        type: "tool_execution_start",
        toolCallId: "script/1",
        parentToolCallId: "script",
        toolName: "read",
        args: { path: "a.ts" },
      });
      projection.projectEvent({
        type: "tool_execution_update",
        toolCallId: "script/1",
        parentToolCallId: "script",
        toolName: "read",
        args: { path: "a.ts" },
        partialResult: { content: [{ type: "text", text: "partial child output" }], details: {} },
      });
    });
    const summary = (await screen.findByText("Work log")).closest("summary");
    if (!summary) throw new Error("Missing work log disclosure");
    await user.click(summary);
    await user.click(await screen.findByRole("button", { name: /^codemode/ }));
    const region = await screen.findByRole("region", { name: "Nested tool activity" });
    await user.click(within(region).getByRole("button", { name: /^read/ }));
    expect(
      within(region).getByRole("button", { name: /^read/ }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(region.textContent).toContain("partial child output");
    await act(async () =>
      projection.projectEvent({
        type: "tool_execution_end",
        toolCallId: "script/1",
        parentToolCallId: "script",
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "live child output" }], details: {} },
      }),
    );
    expect(region.textContent).toContain("live child output");
    expect(region.querySelectorAll('[data-slot="tool"]')).toHaveLength(1);
    await act(async () =>
      applyConversationUpdate(model, {
        _tag: "Snapshot",
        revision: ++revision,
        snapshot: { ...snapshot, streaming: false, parts: projectSessionEntries(nestedEntries()) },
      }),
    );
    expect(region.querySelectorAll('[data-slot="tool"]')).toHaveLength(3);
    expect(region.textContent).toContain("Output unavailable in saved history");
    const tools = region.querySelectorAll('[data-slot="tool"]');
    await user.click(within(tools[1] as HTMLElement).getByRole("button", { name: /^read/ }));
    await user.click(within(tools[2] as HTMLElement).getByRole("button", { name: /^write/ }));
    expect(tools[1]?.textContent).toContain("Recorded error summary");
    expect(tools[1]?.textContent).toContain("Read cancelled");
    expect(tools[2]?.textContent).toContain(
      `Arguments not recorded (${nestedArgumentBytes} bytes)`,
    );
    expect(region.textContent).toContain("Incomplete record");
    expect(screen.getByText("Returned output")).toBeTruthy();
  } finally {
    view.unmount();
    projection.dispose();
  }
});
