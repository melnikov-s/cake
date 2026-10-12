import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Annotation } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import type { MessageSelectionAnchor } from "../../../src/renderer/stores/MessageCommentsStore";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

export const commentSelection: MessageSelectionAnchor = {
  messageId: "assistant-1",
  entryId: "entry-1",
  selectedText: "Original selection",
  startOffset: 4,
  endOffset: 22,
  contextBefore: "The ",
  contextAfter: " matters.",
};

export const preparedAnnotations: Omit<Annotation, "id">[] = [
  {
    messageId: "selection:assistant-1:4:22",
    selectedText: "Original",
    startOffset: 0,
    endOffset: 8,
    contextBefore: "",
    contextAfter: " selection",
    comment: "Go deeper",
  },
  {
    messageId: "selection:assistant-1:4:22",
    selectedText: "selection",
    startOffset: 9,
    endOffset: 18,
    contextBefore: "Original ",
    contextAfter: "",
    comment: "Remove this note",
  },
];

export function renderAnnotationComment(start: Client["discussionSessions"]["start"]) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "parent-1", projectPath: "/project" })],
    client: { discussionSessions: { start } },
  });
  const session = fixture.root.sessionRegistry.load("parent-1", "/project");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
  fixture.root.appShellStore.selectProjectSession("parent-1");
  applyConversationSnapshot(session.model, {
    sessionId: "parent-1",
    sessionFile: "/sessions/parent-1.jsonl",
    parts: [
      {
        id: "assistant-1",
        entryId: "entry-1",
        kind: "text",
        role: "assistant",
        text: "The Original selection matters.",
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
  });
  // Start with an already-prepared selection/comment draft. Native selection
  // initiation, annotation placement and geometry require Electron, not jsdom.
  const comments = session.messageCommentsStore;
  comments.prepareDraft(commentSelection);
  for (const annotation of preparedAnnotations) comments.annotationDraft.add(annotation);
  const view = render(
    <Chat store={comments.draftChatStore} embedded composerFocusEnabled={false} />,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
