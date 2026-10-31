import { observer } from "r-state-tree/react";
import { Chat } from "./chat";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { MarkdownCodeBlock } from "./ai-elements/markdown-code-block";
import type { WorkflowRunStore } from "../stores/WorkflowRunStore";

export const WorkflowWorkerDetail = observer(function WorkflowWorkerDetail({
  store,
}: {
  store: WorkflowRunStore;
}) {
  const step = store.step;
  if (!step) return null;
  return (
    <section
      aria-label="Worker details"
      className="grid min-w-0 grid-cols-1 gap-2.5 rounded-lg border border-border/75 bg-card/55 p-3.5"
    >
      <div className="grid gap-1">
        <h3 className="text-xs font-semibold text-foreground">
          {step.input.options.label ?? `Worker ${step.ordinal + 1}`}
        </h3>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {step.status} · Attempt {step.attempt}/6 · {step.resolvedModel.provider}/
          {step.resolvedModel.modelId}
        </p>
        <p className="break-all font-mono text-xs text-muted-foreground">{step.workingDirectory}</p>
        {step.usage && (
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {step.usage.tokens.total.toLocaleString()} billed tokens · ${step.usage.cost.toFixed(4)}
          </p>
        )}
      </div>
      <div className="grid gap-1 rounded-md border border-border/65 bg-background/60 p-2.5">
        <h4 className="text-xs font-semibold text-foreground">Assignment</h4>
        <p className="whitespace-pre-wrap text-xs text-foreground/90">{step.input.prompt}</p>
        {step.input.options.instructions && (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
            {step.input.options.instructions}
          </p>
        )}
      </div>
      {step.input.options.schema !== undefined && (
        <MarkdownCodeBlock
          code={JSON.stringify(step.input.options.schema, null, 2)}
          language="json"
          meta=""
          isIncomplete={false}
        />
      )}
      <div className="flex flex-wrap gap-1.5">
        {(step.status === "running" || step.status === "queued") && (
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(store.pending)}
            onClick={() => void store.controlWorker("stopWorker")}
          >
            Stop worker
          </Button>
        )}
        {step.status !== "complete" && (
          <Button
            variant="outline"
            size="sm"
            disabled={
              Boolean(store.pending) || step.attempt >= 6 || store.detail?.status !== "running"
            }
            onClick={() => void store.controlWorker("restartWorker")}
          >
            Restart worker
          </Button>
        )}
      </div>
      <div className="h-72 min-h-0 overflow-hidden rounded-lg border border-border/75 bg-background">
        <Chat
          store={store.workerChat}
          embedded
          compact
          showContextUsage={false}
          empty={<p className="p-3 text-xs text-muted-foreground">No worker activity available.</p>}
        />
      </div>
      {step.result !== undefined && (
        <section aria-label="Worker result" className="grid gap-1.5">
          <h4 className="text-xs font-semibold text-foreground">Worker result</h4>
          <MarkdownCodeBlock
            code={JSON.stringify(step.result, null, 2)}
            language="json"
            meta=""
            isIncomplete={false}
          />
        </section>
      )}
      {step.error && <Callout variant="error">{step.error}</Callout>}
    </section>
  );
});
