import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import type { WorkflowRunStore } from "../stores/WorkflowRunStore";

export const WorkflowProgress = observer(function WorkflowProgress({
  store,
  onDetails,
}: {
  store: WorkflowRunStore;
  onDetails?(): void;
}) {
  if (!store.runs.length) return null;
  return (
    <section aria-label="Workflow runs" className="grid gap-3 py-4">
      {store.error && (
        <Callout variant="error" role="alert">
          {store.error}
        </Callout>
      )}
      {store.runs.map((run) => (
        <article
          key={run.id}
          data-slot="workflow-progress"
          className="grid gap-2.5 rounded-xl border border-border/75 bg-card p-3.5 text-sm shadow-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm font-semibold">{run.meta.name}</strong>
              <Badge variant="secondary">{run.status}</Badge>
            </div>
            {run.usage && (
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {run.usage.tokens.total.toLocaleString()} billed tokens · $
                {run.usage.cost.toFixed(4)}
              </p>
            )}
          </div>
          {run.meta.description && (
            <p className="text-xs text-muted-foreground">{run.meta.description}</p>
          )}
          <p className="font-mono text-xs tabular-nums text-foreground/90">
            {run.phase && `${run.phase} · `}
            {run.complete}/{run.total} complete · {run.active} active · {run.queued} queued
            {run.failed > 0 && ` · ${run.failed} failed`}
            {run.aborted > 0 && ` · ${run.aborted} aborted`}
          </p>
          {run.error && <Callout variant="error">{run.error}</Callout>}
          {(run.total > 25 || (run.usage?.tokens.total ?? 0) > 1_500_000) && (
            <Callout variant="warning">
              Large workflow. Monitor billed usage and incomplete coverage.
            </Callout>
          )}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onDetails?.();
                store.open(run.id);
              }}
            >
              Details
            </Button>
            {run.status === "running" && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(store.pending)}
                onClick={() => void store.control(run.id, "pause")}
              >
                Pause
              </Button>
            )}
            {run.status === "paused" && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(store.pending)}
                onClick={() => void store.control(run.id, "resume")}
              >
                Resume
              </Button>
            )}
            {(run.status === "running" || run.status === "paused") && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(store.pending)}
                onClick={() => void store.control(run.id, "stop")}
              >
                Stop
              </Button>
            )}
            {!["running", "paused", "stopping"].includes(run.status) && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(store.pending)}
                onClick={() => void store.control(run.id, "relaunch")}
              >
                Relaunch
              </Button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
});
