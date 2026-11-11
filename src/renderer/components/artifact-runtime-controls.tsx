import { observer } from "r-state-tree/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import type { ArtifactDetailStore } from "../stores/ArtifactDetailStore";

export const ArtifactRuntimeControls = observer(function ArtifactRuntimeControls({
  store,
}: {
  store: ArtifactDetailStore;
}) {
  const status = store.execution;
  if (!status?.executable && !store.runtimeError) return null;
  return (
    <section className="grid gap-2 border-b border-border/65 py-4" aria-label="Artifact runtime">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold">Runtime</h2>
        {status?.executable && (
          <Badge variant="secondary">
            {status.attachedRevision === null
              ? "Not attached"
              : status.backgroundPaused
                ? "Background paused"
                : status.running
                  ? "Running"
                  : status.lastError
                    ? "Failed"
                    : "Stopped"}
          </Badge>
        )}
      </div>
      {(store.runtimeError || status?.lastError) && (
        <Callout variant="error">{store.runtimeError ?? status?.lastError}</Callout>
      )}
      {status?.executable ? (
        <div className="flex flex-wrap gap-1.5">
          {status.backgroundPaused ? (
            <Button
              size="sm"
              variant="outline"
              disabled={store.runtimePending}
              onClick={() => void store.controlRuntime("resume")}
            >
              Resume background
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={store.runtimePending}
              onClick={() => void store.controlRuntime("pause")}
            >
              Pause background
            </Button>
          )}
          {!status.running && (
            <Button
              size="sm"
              variant="outline"
              disabled={store.runtimePending}
              onClick={() => void store.controlRuntime("start")}
            >
              Start runtime
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={store.runtimePending}
            onClick={() => void store.controlRuntime("restart")}
          >
            Restart runtime
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={store.runtimePending}
            onClick={() => void store.refreshExecution()}
          >
            Refresh status
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void store.refreshExecution()}>
          Retry runtime status
        </Button>
      )}
    </section>
  );
});
