import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VirtuosoMockContext } from "react-virtuoso";
import type { ConversationSnapshot } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

export function addedFile(state: ToolPart["state"] = "success"): ToolPart {
  return {
    id: "tool-write",
    kind: "tool",
    name: "write",
    input: JSON.stringify({ path: "src/added.ts", content: "one\ntwo\nthree" }),
    filePath: "src/added.ts",
    state,
  };
}

export function removedFile(state: ToolPart["state"] = "success"): ToolPart {
  return {
    id: "tool-remove",
    kind: "tool",
    name: "remove",
    input: JSON.stringify({ path: "src/removed.ts" }),
    filePath: "src/removed.ts",
    diff: "--- a/src/removed.ts\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-oldOne\n-oldTwo\n-oldThree\n-oldFour",
    state,
  };
}

export function readFile(id: string, state: ToolPart["state"] = "success"): ToolPart {
  return {
    id,
    kind: "tool",
    name: "read",
    input: JSON.stringify({ path: `${id}.ts` }),
    filePath: `${id}.ts`,
    output: `Contents of ${id}`,
    state,
  };
}

export function renderWorkLog(parts: UiPart[], options: { streaming?: boolean } = {}) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: "work-log", projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load("work-log", "/project");
  fixture.root.appShellStore.selectProjectSession("work-log");
  fixture.root.projectWorkbenchStore.showLoadedSession("work-log");
  const snapshot: ConversationSnapshot = {
    sessionId: "work-log",
    sessionFile: "/project/work-log.jsonl",
    parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: options.streaming ?? false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
  let revision = 1;
  applyConversationUpdate(session.model, { _tag: "Snapshot", revision, snapshot });
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 100 }}>
      <Chat
        store={session.conversationSessionStore.chatStore}
        compact
        composerFocusEnabled={false}
      />
    </VirtuosoMockContext.Provider>,
  );
  return {
    user: userEvent.setup(),
    container: view.container,
    publish(nextParts: UiPart[], streaming = false) {
      act(() => {
        applyConversationUpdate(session.model, {
          _tag: "Snapshot",
          revision: ++revision,
          snapshot: { ...snapshot, parts: nextParts, streaming },
        });
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
