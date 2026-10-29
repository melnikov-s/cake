/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { RendererRoot } from "../../../src/renderer/components/renderer-root";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";
const sourceId = "source-session";
const inboxId = "inbox-session";
const sender = { kind: "project-session" as const, sessionId: sourceId, title: "API review" };
const metadata = {
  version: 1 as const,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 1,
  expectsResponse: false,
  sender,
};
const reportText = encodeCrossSessionMessage(
  "## Report findings\n\nKeep **this evidence**.",
  metadata,
);
const historicalText = encodeCrossSessionMessage("Historical findings.", {
  ...metadata,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c624",
  sequence: 2,
  sender: { ...sender, title: sourceId },
});

function renderChatWorkspaceFinish(open: Client["projectSessions"]["open"]) {
  const inbox = sessionSummary({ sessionId: inboxId, projectPath, title: "Review inbox" });
  const source = sessionSummary({ sessionId: sourceId, projectPath, title: "Current API review" });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions: [inbox, source],
    client: { projectSessions: { open } },
  });
  const reports = projectSessionEntries(
    [reportText, historicalText].map((content, index) => ({
      type: "message" as const,
      id: `incoming-${index}`,
      parentId: index === 0 ? null : "incoming-0",
      timestamp: new Date(index).toISOString(),
      message: { role: "user" as const, timestamp: index, content },
    })),
  );
  for (const [sessionId, parts] of [
    [inboxId, reports],
    [
      sourceId,
      [
        {
          id: "source-evidence",
          kind: "text",
          role: "assistant",
          text: "Source runtime evidence",
          status: "complete",
        },
      ],
    ],
  ] satisfies Array<[string, UiPart[]]>) {
    const session = fixture.root.sessionRegistry.load(sessionId, projectPath);
    const snapshot: ConversationSnapshot = {
      sessionId,
      sessionFile: `${projectPath}/${sessionId}.jsonl`,
      parts,
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    };
    applyConversationUpdate(session.model, { _tag: "Snapshot", revision: 1, snapshot });
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  }
  fixture.root.navigationStore.showLoadedProjectSession(inboxId);
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <RendererRoot
        rootStore={fixture.root}
        openSubagent={(parent, handle, message) =>
          void fixture.root.navigationStore.openSubagentLink(parent, handle, message)
        }
        openExternalUrl={(url) => void fixture.root.openExternalUrl(url)}
        openSession={(id, messageId, attachmentId) =>
          void fixture.root.navigationStore.openSessionLink(id, messageId, attachmentId)
        }
      />
    </VirtuosoMockContext.Provider>,
  );
  return {
    user: userEvent.setup(),
    async publishSource(title: string | null) {
      await act(async () =>
        applySnapshot(fixture.models.sessionCatalog, {
          sessions: title === null ? [inbox] : [inbox, { ...source, title }],
          resolvedHasMoreByProject: {},
        }),
      );
    },
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

// Real persisted reports -> renderer providers -> catalog title authority and
// navigation. The RendererRoot callbacks route to real Root operations, matching
// main.ts; only the external runtime-open service is faked. No fake link handlers.
it("opens a report's recorded source, follows catalog renames and falls back honestly after removal", async () => {
  const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
  using fixture = renderChatWorkspaceFinish(open);
  const reports = () => screen.getAllByRole("region", { name: "Message from another session" });
  const firstReport = () => within(reports()[0]!);
  expect(firstReport().getByRole("button", { name: "Current API review" })).toBeDefined();
  const link = firstReport().getByRole("link", { name: "Open conversation" });
  expect(link.getAttribute("href")).toBe(`cake://session/${sourceId}`);
  expect(firstReport().getByRole("heading", { name: "Report findings" })).toBeDefined();
  expect(firstReport().getByText("this evidence").getAttribute("data-streamdown")).toBe("strong");
  // Older ID-only metadata also recovers a readable title from real authority.
  expect(within(reports()[1]!).getByRole("button", { name: "Current API review" })).toBeDefined();

  await fixture.user.click(link);
  expect(await screen.findByText("Source runtime evidence")).toBeDefined();
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      { sessionId: sourceId, workingDirectory: projectPath },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  await fixture.user.click(screen.getByRole("button", { name: /^Review inbox / }));
  expect(await screen.findByRole("heading", { name: "Report findings" })).toBeDefined();

  await fixture.publishSource("Renamed API review");
  for (const report of reports())
    expect(within(report).getByRole("button", { name: "Renamed API review" })).toBeDefined();
  await fixture.publishSource(null);
  expect(firstReport().getByRole("button", { name: "API review" })).toBeDefined();
  expect(within(reports()[1]!).getByRole("button", { name: "Untitled session" })).toBeDefined();
  expect(reports()[0]!.textContent).not.toContain("cake-session-message");
});
