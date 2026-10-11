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
      className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-border p-3"
    >
      <h3 className="font-semibold">{step.input.options.label ?? `Worker ${step.ordinal + 1}`}</h3>
      <p>
        {step.status} · Attempt {step.attempt}/6 · {step.resolvedModel.provider}/
        {step.resolvedModel.modelId}
      </p>
      <p className="break-all font-mono text-xs text-muted-foreground">{step.workingDirectory}</p>
      {step.usage && (
        <p className="font-mono text-xs text-muted-foreground">
          {step.usage.tokens.total.toLocaleString()} billed tokens · ${step.usage.cost.toFixed(4)}
        </p>
      )}
      <h4 className="font-semibold">Assignment</h4>
      <p className="whitespace-pre-wrap">{step.input.prompt}</p>
      {step.input.options.instructions && (
        <p className="whitespace-pre-wrap">{step.input.options.instructions}</p>
      )}
      {step.input.options.schema !== undefined && (
        <MarkdownCodeBlock
          code={JSON.stringify(step.input.options.schema, null, 2)}
          language="json"
          meta=""
          isIncomplete={false}
        />
      )}
      <div className="flex flex-wrap gap-2">
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
      <div className="h-72 min-h-0">
        <Chat
          store={store.workerChat}
          embedded
          compact
          showContextUsage={false}
          empty={<p className="p-3 text-muted-foreground">No worker activity available.</p>}
        />
      </div>
      {step.result !== undefined && (
        <section aria-label="Worker result">
          <h4 className="font-semibold">Worker result</h4>
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
