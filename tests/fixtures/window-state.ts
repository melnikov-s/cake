import { randomUUID } from "node:crypto";
import { WINDOW_STATE_DOCUMENT_VERSION } from "../../src/services/storage/WindowStateStorage";

type Node = { state: object; children: object };
export const store = (state: object = {}, children: object = {}): Node => ({ state, children });

export interface WindowStateOptions {
  /** Project opened on launch. */
  readonly project: string;
  /** Existing Project Session selected on launch; otherwise a fresh staged session is selected. */
  readonly sessionId?: string;
  readonly theme?: "system" | "light" | "dark";
  /** Sidebar Project order; defaults to the opened Project only. */
  readonly projects?: readonly string[];
}

const sessionStore = (sessionId: string) => ({
  key: sessionId,
  ...store(
    {},
    {
      conversationSessionStore: store(
        {},
        {
          composerStore: store(
            {},
            { draftStore: store({ text: "", attachments: [], annotations: [] }) },
          ),
          chatStore: store(),
        },
      ),
    },
  ),
});

/** Renderer Store snapshot children that open a Project and select one of its sessions. */
export function windowStateChildren(options: WindowStateOptions): Record<string, Node> {
  const sessionId = options.sessionId ?? randomUUID();
  const staged = options.sessionId === undefined;
  const selection = { kind: "project-session", sessionId };
  return {
    appShellStore: store({
      navigationVersion: 2,
      workspace: "project-sessions",
      sessionHistory: [selection],
      sessionHistoryCursor: 0,
    }),
    sessionLayoutStore: store({
      layout: { kind: "pane", paneId: "initial-pane", history: [sessionId], historyCursor: 0 },
      focusedPaneId: "initial-pane",
    }),
    projectWorkbenchStore: store({}, { projectOpenStore: store({ projectPath: options.project }) }),
    projectCatalogStore: store({ projectOrder: options.projects ?? [options.project] }),
    sessionRegistry: store(
      { targets: [{ sessionId, workspacePath: options.project }] },
      {
        sessions: [sessionStore(sessionId)],
        pendingSessions: staged
          ? store(
              {
                temporarySessionIds: [sessionId],
                stagedSessionIds: [sessionId],
                conversationIds: [sessionId],
              },
              {
                conversations: [
                  {
                    key: sessionId,
                    ...store({
                      createdAt: new Date(0).toISOString(),
                      modifiedAt: new Date(0).toISOString(),
                      messageCount: 0,
                    }),
                  },
                ],
              },
            )
          : store(),
        observationRetention: store({ materializedSessionIds: staged ? [] : [sessionId] }),
      },
    ),
    settingsStore: store(
      {},
      {
        appearance: store({
          theme: options.theme ?? "system",
          workLogViewMode: "auto",
          workLogsExpansion: "collapsed",
        }),
      },
    ),
  };
}

/** Serializes renderer Store snapshot children as a current-version window-state document. */
export const windowStateDocument = (children: Record<string, Node>) =>
  JSON.stringify({ version: WINDOW_STATE_DOCUMENT_VERSION, data: store({}, children) });

export const windowState = (options: WindowStateOptions) =>
  windowStateDocument(windowStateChildren(options));
