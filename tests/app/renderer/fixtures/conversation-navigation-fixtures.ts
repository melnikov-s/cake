import { applySnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { ReviewThread } from "../../../../src/renderer/models/ReviewThread";
import type { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { SubagentActivity } from "../../../../src/renderer/models/SubagentActivity";
import { sessionSummary, fixtureTimestamp } from "./catalog-fixtures";

export const navigatorProjectPath = "/cake";
export const navigatorHomeId = `project-chat:${"a".repeat(64)}`;
export const navigatorSessions = [
  sessionSummary({
    sessionId: "layout",
    title: "UI Layout Refactor",
    projectPath: navigatorProjectPath,
    familyId: "layout",
    familyChildSessionIds: ["keyboard"],
    familyDepth: 0,
  }),
  sessionSummary({
    sessionId: "keyboard",
    title: "Keyboard Editing & Navigation",
    projectPath: navigatorProjectPath,
    familyId: "layout",
    familyParentSessionId: "layout",
    familyDepth: 1,
    familyChildOrder: 0,
    familyChildSessionIds: ["deep-child"],
  }),
  sessionSummary({
    sessionId: "deep-child",
    title: "Nested child implementation",
    projectPath: navigatorProjectPath,
    familyId: "layout",
    familyParentSessionId: "keyboard",
    familyDepth: 2,
    familyChildOrder: 0,
  }),
  sessionSummary({
    sessionId: "icons",
    title: "Icon Placement Exploration",
    projectPath: navigatorProjectPath,
  }),
  sessionSummary({
    sessionId: "elsewhere",
    title: "Other project session",
    projectPath: "/other",
    running: true,
  }),
];

/** Real authority-shaped identities, never product demo records. Also reusable by maintained visual scenarios. */
export function populateConversationNavigationFixture(model: RootProjection) {
  applySnapshot(model.cakeChatCatalog, {
    loaded: true,
    sessions: [
      {
        sessionId: navigatorHomeId,
        title: "cake / Project Chat",
        projectPath: navigatorProjectPath,
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 2,
      },
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        title: "Cake Chat",
        createdAt: fixtureTimestamp,
        modifiedAt: fixtureTimestamp,
        messageCount: 2,
      },
    ],
  });
  const addThread = (
    parentSessionId: string,
    id: string,
    sidecarSessionId: string,
    title: string,
  ) => {
    const thread = ReviewThread.create({
      id,
      parentSessionId,
      sidecarSessionId,
      workingDirectory: navigatorProjectPath,
      status: "open",
      createdAt: fixtureTimestamp,
      updatedAt: fixtureTimestamp,
    });
    thread.anchor = { ...thread.anchor, view: "message", path: "message", selectedText: title };
    model.discussionCatalog(parentSessionId).threads.push(thread);
    model.discussionConversation(sidecarSessionId, navigatorProjectPath, parentSessionId);
  };
  addThread(navigatorHomeId, "decisions", "decisions-chat", "Navigation decisions");
  addThread("layout", "widths", "widths-chat", "Pane widths");
  addThread("keyboard", "focus", "focus-chat", "Focus restoration");
  addThread("focus-chat", "deep-discussion", "deep-discussion-chat", "Selection-path discussion");
  addThread(CAKE_CHAT_SESSION_ID, "planning", "planning-chat", "Weekly planning");
  let handle = 0;
  const addWorker = (
    parentSessionId: string,
    task: string,
    status: "running" | "complete" = "running",
  ) => {
    const handleId = `10000000-0000-4000-8000-${String(++handle).padStart(12, "0")}`;
    model.subagentCatalog(parentSessionId).loaded = true;
    model.subagentCatalog(parentSessionId).activities.push(
      SubagentActivity.create({
        parentSessionId,
        handleId,
        anchorPartId: `spawn-${handle}`,
        revision: 1,
        task,
        projectPath: navigatorProjectPath,
        status,
        streaming: status === "running",
      }),
    );
    return handleId;
  };
  addWorker("layout", "Breadcrumb audit");
  addWorker("layout", "Icon and tooltip audit");
  addWorker("layout", "Dense tree review");
  addWorker("keyboard", "Shortcut review");
  const deepHandleId = addWorker("focus-chat", "Selection-path audit");
  addWorker("decisions-chat", "Screenshot comparison", "complete");
  addWorker("planning-chat", "Global project summary");
  // Unrelated active workers must not inflate the project/global tree counts.
  addWorker("elsewhere", "Unrelated worker");
  return { deepHandleId };
}
