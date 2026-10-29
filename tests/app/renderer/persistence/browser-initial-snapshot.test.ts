import { describe, expect, it } from "vitest";
import type { StoreSnapshot } from "r-state-tree";
import { browserInitialSnapshot } from "../../../../src/renderer/bootstrap/browser-initial-snapshot";
import type { AppSelection } from "../../../../src/renderer/stores/AppShellStore";

const selections: AppSelection[] = [
  { kind: "project-session", sessionId: "previous" },
  { kind: "settings" },
  { kind: "artifact-library" },
  { kind: "workbench" },
  { kind: "cake-chat" },
];

// Visible startup/restoration is covered by persistence-finish-workflow.test.tsx. Keep the
// bootstrap data contract here: phone startup must not destroy saved pane history/preferences,
// including presentations that do not currently display a conversation.
describe("browser presentation snapshot boundary", () => {
  it("preserves source data, pane history and sidebar preferences for every saved surface", () => {
    for (const selection of selections) {
      for (const hidden of [false, true]) {
        const saved: StoreSnapshot = {
          state: {},
          children: {
            sidebarStore: {
              state: { hidden, width: 330, navigationMode: "activity" },
              children: {},
            },
            appShellStore: {
              state: {
                selection,
                activeConversation: { kind: "project-session", sessionId: "previous" },
                sessionHistory: [{ kind: "project-session", sessionId: "previous" }],
                sessionHistoryCursor: 0,
              },
              children: {},
            },
            sessionLayoutStore: {
              state: {
                layout: {
                  kind: "pane",
                  paneId: "saved-pane",
                  history: ["previous"],
                  historyCursor: 0,
                },
                focusedPaneId: "saved-pane",
              },
              children: {},
            },
          },
        };
        const before = structuredClone(saved);
        const phone = browserInitialSnapshot(saved, true);
        expect(phone.children.sessionLayoutStore).toEqual(saved.children.sessionLayoutStore);
        expect(phone.children.sidebarStore).toMatchObject({
          state: { hidden: true, width: 330, navigationMode: "activity" },
        });
        expect(browserInitialSnapshot(saved, false)).toEqual(saved);
        expect(saved).toEqual(before);
      }
    }
  });
});
