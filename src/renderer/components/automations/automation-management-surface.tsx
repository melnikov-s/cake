import { useRef } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { LoadingState } from "../ui/loading-state";
import { DialogBackdrop, DialogContent, DialogTitle, DialogFooter } from "../ui/dialog";
import { cn } from "../../lib/utils";
import { AutomationOverview } from "./automation-overview";
import { AutomationDefinition } from "./automation-definition";
import { AutomationMemory } from "./automation-memory";
import { AutomationRuns } from "./automation-runs";

export const AutomationManagementSurface = observer(function AutomationManagementSurface() {
  const root = useStore(RootStore);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const dismissArchive = () => {
    root.automationsStore.dismissArchiveConfirmation();
    archiveButton.current?.focus();
  };
  const hub = root.automationsStore;
  const editor = hub.editor;
  const id = hub.selectedId;
  const state =
    hub.catalog.automations.find((item) => item.id === id)?.state ?? editor.automation?.state;
  const error =
    hub.error ??
    editor.error ??
    hub.catalog.observationError ??
    root.automationSessionsStore.sessions.find((session) => session.error)?.error;
  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="automation-management">
      {error && (
        <Callout variant="error" role="alert" className="mx-8 mt-4">
          {error}
        </Callout>
      )}
      {hub.globalHistory ? (
        <>
          <div className="px-8 pt-5">
            <Button size="sm" variant="ghost" onClick={() => hub.showOverview()}>
              All automations
            </Button>
          </div>
          <AutomationRuns />
        </>
      ) : !id && !editor.creating ? (
        <AutomationOverview />
      ) : (
        <>
          <header className="shrink-0 px-8 pb-4 pt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Button size="sm" variant="ghost" onClick={() => hub.showOverview()}>
                All automations
              </Button>
              {id && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      hub.changing || state?._tag === "suspended" || state?._tag === "archived"
                    }
                    onClick={() => void hub.runNow(id)}
                  >
                    Run now
                  </Button>
                  {state?._tag !== "archived" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={hub.changing}
                      onClick={() =>
                        void (state?._tag === "active" ? hub.pause(id) : hub.activate(id))
                      }
                    >
                      {state?._tag === "active"
                        ? "Pause automation"
                        : state?._tag === "suspended"
                          ? "Retry activation"
                          : "Resume automation"}
                    </Button>
                  )}
                  {state?._tag === "archived" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={hub.changing}
                      onClick={() => void hub.activate(id)}
                    >
                      Restore automation
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={hub.changing}
                      ref={archiveButton}
                      onClick={() => void hub.requestArchive(id)}
                    >
                      Archive
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <h1 className="font-display text-xl font-semibold tracking-tight">
                {editor.creating ? "New automation" : (editor.definition?.name ?? "Automation")}
              </h1>
              {state && !editor.creating && (
                <span className="rounded-full border border-border/75 bg-muted px-2 py-1 text-xs">
                  {state._tag}
                </span>
              )}
            </div>
            {state?._tag === "suspended" && (
              <Callout variant="warning" className="mt-4">
                {state.reason}
              </Callout>
            )}
            {hub.lastTrigger && (
              <p className="mt-3 text-xs" role="status">
                {hub.lastTrigger._tag === "queued"
                  ? "Occurrence queued"
                  : hub.lastTrigger._tag === "started"
                    ? "Run started"
                    : `${hub.lastTrigger._tag}: ${hub.lastTrigger.reason}`}
              </p>
            )}
          </header>
          {!editor.creating && (
            <nav
              className="flex shrink-0 gap-6 border-b border-border/65 px-8"
              aria-label="Automation panes"
            >
              {(["definition", "runs", "memory"] as const).map((tab) => (
                <Button
                  key={tab}
                  variant="ghost"
                  className={cn(
                    "rounded-none px-0 pb-3 text-xs",
                    hub.tab === tab && "border-b-2 border-accent text-foreground",
                  )}
                  aria-pressed={hub.tab === tab}
                  onClick={() => void hub.showTab(tab)}
                >
                  {tab[0]!.toUpperCase() + tab.slice(1)}
                </Button>
              ))}
            </nav>
          )}
          {editor.loading ? (
            <div className="p-8">
              <LoadingState label="Loading automation" />
            </div>
          ) : hub.tab === "definition" || editor.creating ? (
            <AutomationDefinition />
          ) : hub.tab === "runs" ? (
            <AutomationRuns />
          ) : (
            <AutomationMemory />
          )}
        </>
      )}
      {hub.archiveConfirmationId && (
        <DialogBackdrop
          aria-label="Archive automation"
          onClose={dismissArchive}
          onKeyDown={(event) => {
            if (event.key === "Escape") dismissArchive();
          }}
        >
          <DialogContent>
            <DialogTitle>Archive automation</DialogTitle>
            <p className="mt-4 text-sm">
              Let running sessions finish, or stop them? Queued occurrences will be canceled.
            </p>
            <DialogFooter>
              <Button variant="ghost" autoFocus onClick={dismissArchive}>
                Cancel
              </Button>
              <Button
                variant="outline"
                disabled={hub.changing}
                onClick={() => {
                  if (hub.archiveConfirmationId)
                    void hub.archive(hub.archiveConfirmationId, "let-finish");
                }}
              >
                Let finish
              </Button>
              <Button
                variant="destructive"
                disabled={hub.changing}
                onClick={() => {
                  if (hub.archiveConfirmationId)
                    void hub.archive(hub.archiveConfirmationId, "stop");
                }}
              >
                Stop and archive
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogBackdrop>
      )}
    </div>
  );
});
