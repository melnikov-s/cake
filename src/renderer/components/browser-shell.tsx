import { observer, StoreProvider } from "r-state-tree/react";
import type { BrowserShellStore } from "../stores/BrowserShellStore";
import { MarkdownLinkProvider } from "./ai-elements/markdown";
import { BrowserChat } from "./browser-chat";
import { RendererErrorBoundary } from "./renderer-error-boundary";
import { UiDialog } from "./ui-dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { Select } from "./ui/select";
import { SavedDraftRecovery } from "./saved-draft-recovery";
import { BrowserSavedDraftEditor } from "./browser-saved-draft-editor";

export const BrowserShell = observer(function BrowserShell({
  store,
}: {
  store: BrowserShellStore;
}) {
  const navigation = store.navigation;
  const active = store.active;
  return (
    <RendererErrorBoundary>
      <StoreProvider store={store.fullscreen}>
        <MarkdownLinkProvider
          actions={{
            openExternalUrl: (url) => {
              void store.client.electron
                .openExternalUrl(url)
                .catch((error: unknown) => store.reportError(error));
            },
            openSession: (id) => {
              if (!navigation.selectSession(id))
                store.reportError(
                  new Error("That session is not in the loaded active project catalog."),
                );
            },
            loadWorkspaceImage: (path, signal) =>
              active
                ? store.client.filesystem.readImage(active.workingDirectory, path, { signal })
                : Promise.reject(new Error("No active project session")),
            renderArtifactReference: (reference) => (
              <Badge variant="mono" title={reference}>
                Artifact: open in the desktop app
              </Badge>
            ),
          }}
        >
          <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <strong className="text-sm">Cake</strong>
              <Select
                aria-label="Project"
                className="w-auto max-w-full"
                value={navigation.projectPath ?? ""}
                onChange={(event) => navigation.selectProject(event.target.value)}
              >
                <option value="">Choose project</option>
                {navigation.projects.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Session"
                className="w-auto max-w-full"
                value={navigation.sessionId ?? ""}
                onChange={(event) => navigation.selectSession(event.target.value)}
              >
                <option value="">Choose session</option>
                {navigation.sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.title || "Untitled session"}
                  </option>
                ))}
                {navigation.savedDraftSessions.map((draft) => (
                  <option key={draft.sessionId} value={draft.sessionId}>
                    {draft.title} (saved Draft{draft.status === "activating" ? " · starting" : ""})
                  </option>
                ))}
                {navigation.unsentSessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    New chat (unsent)
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                disabled={!navigation.projectPath || !store.connected}
                onClick={() => navigation.newChat()}
              >
                New chat
              </Button>
              <span className="ml-auto text-xs text-muted-foreground" role="status">
                {store.connected
                  ? "Connected"
                  : store.everConnected
                    ? "Disconnected · reconnecting…"
                    : "Connecting…"}
              </span>
            </header>
            {!store.connected && (
              <Callout variant="warning">
                Commands are unavailable while disconnected. Accepted server work continues; no
                messages are automatically resent.
              </Callout>
            )}
            {store.error && <Callout variant="error">{store.error}</Callout>}
            {active?.savedDraft?.status === "saved" && <BrowserSavedDraftEditor session={active} />}
            {active?.savedDraft?.status === "activating" && (
              <SavedDraftRecovery
                disabled={!store.connected}
                recover={() => void active.recoverUncertainDraft()}
              />
            )}
            {active ? (
              <BrowserChat key={active.id} session={active} />
            ) : (
              <div className="p-6 text-sm text-muted-foreground">
                Choose a registered project and a session, or start a new chat. Editor, Draw,
                terminals, attachments and provider setup are desktop-only.
              </div>
            )}
            {store.extensionUi.request && (
              <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-background/90 p-4">
                <UiDialog
                  key={store.extensionUi.request.uiRequestId}
                  request={store.extensionUi.request}
                  extensionUi={store.extensionUi}
                />
              </div>
            )}
            {store.extensionUi.error && (
              <Callout variant="error">{store.extensionUi.error}</Callout>
            )}
          </main>
        </MarkdownLinkProvider>
      </StoreProvider>
    </RendererErrorBoundary>
  );
});
