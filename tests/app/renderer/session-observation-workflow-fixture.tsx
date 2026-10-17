import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const projectPath = "/project";

/** User navigation is real; only session opening and conversation authority are controlled. */
export function renderSessionObservation(options: { restored?: boolean; split?: boolean } = {}) {
  const sessions = [
    ...["selected", "visible", "running", ...Array.from({ length: 6 }, (_, i) => `idle-${i}`)].map(
      (sessionId) => sessionSummary({ sessionId, projectPath, title: `Task ${sessionId}` }),
    ),
    sessionSummary({ sessionId: "archive", projectPath, title: "Archived task", resolved: true }),
  ];
  const opened: string[] = [];
  const open: Client["projectSessions"]["open"] = async ({ sessionId }) => {
    opened.push(sessionId);
  };
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: projectPath, name: "Project" })],
    sessions,
    snapshot: options.restored
      ? {
          state: {},
          children: {
            sessionRegistry: {
              state: {
                targets: ["selected", "idle-0"].map((sessionId) => ({
                  sessionId,
                  workspacePath: projectPath,
                })),
              },
              children: {
                observationRetention: {
                  state: { materializedSessionIds: ["selected", "idle-0"] },
                  children: {},
                },
              },
            },
          },
        }
      : undefined,
    client: {
      projectSessions: { open },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  const { root, models } = fixture;
  const publish = (sessionId: string, streaming: boolean, revision = 1) =>
    applyConversationUpdate(models.projectConversation(sessionId, projectPath), {
      _tag: "Snapshot",
      revision,
      snapshot: {
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        parts: [],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
  for (const session of sessions) publish(session.sessionId, session.sessionId === "running");
  if (!options.restored) root.sessionRegistry.load("selected", projectPath);
  root.appShellStore.selectProjectSession("selected");
  root.projectWorkbenchStore.showLoadedSession("selected");
  root.sessionLayoutStore.ensureSession("selected");
  if (options.split) {
    root.sessionRegistry.load("visible", projectPath);
    root.sessionRegistry.load("running", projectPath);
    root.sessionLayoutStore.splitFocused("visible", "x");
    root.sessionLayoutStore.focusSession("selected");
  }
  const view = render(
    <StoreProvider store={root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    opened,
    // This is the actual demand output consumed by Model synchronization, not a fake
    // observer. Resource assertions below do not claim transport acquisition/eviction.
    demand: () => root.projectSessionObservationTargets,
    settleRunning() {
      act(() => publish("running", false, 2));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
