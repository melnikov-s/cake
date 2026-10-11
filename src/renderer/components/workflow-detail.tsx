import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";
import { SidePanel } from "./ui/side-panel";
import { MarkdownCodeBlock } from "./ai-elements/markdown-code-block";
import { WorkflowWorkerDetail } from "./workflow-worker-detail";
import type { WorkflowRunStore } from "../stores/WorkflowRunStore";

export const WorkflowDetail = observer(function WorkflowDetail({
  store,
}: {
  store: WorkflowRunStore;
}) {
  const run = store.detail;
  return (
    <SidePanel
      title="Workflow details"
      eyebrow={run?.program?.meta.name ?? "Workflow"}
      onClose={() => store.close()}
    >
      <div className="h-full overflow-auto p-4 text-sm">
        {!run?.loaded ? (
          <LoadingState label="Loading workflow details" />
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-4">
            <p>
              {run.status} · Execution {run.execution} · Concurrency {run.maxConcurrentAgents}
            </p>
            <Callout>
              Pause holds new workers; active workers finish. Stop waits for cancellation cleanup.
              Neither undoes file changes.
            </Callout>
            <section aria-label="Run phases">
              <h3 className="font-semibold">Phases</h3>
              <ol className="list-inside list-decimal">
                {run.phases.map((phase, index) => (
                  <li key={index}>{phase}</li>
                ))}
              </ol>
            </section>
            {run.logs.length > 0 && (
              <section aria-label="Workflow logs">
                <h3 className="font-semibold">Log</h3>
                {run.logs.map((log, index) => (
                  <p className="whitespace-pre-wrap" key={index}>
                    {log}
                  </p>
                ))}
              </section>
            )}
            <section aria-label="Frozen workflow source">
              <h3 className="font-semibold">Frozen source</h3>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {run.program?.sourcePath}
              </p>
              <MarkdownCodeBlock
                code={run.program?.source ?? ""}
                language="javascript"
                meta=""
                isIncomplete={false}
              />
            </section>
            {run.program?.args !== undefined && (
              <section aria-label="Workflow parameters">
                <h3 className="font-semibold">Parameters</h3>
                <MarkdownCodeBlock
                  code={JSON.stringify(run.program.args, null, 2)}
                  language="json"
                  meta=""
                  isIncomplete={false}
                />
              </section>
            )}
            <section aria-label="Workflow workers" className="grid gap-2">
              <h3 className="font-semibold">Workers</h3>
              {run.steps.map((step) => (
                <Button
                  key={step.id}
                  variant="outline"
                  className="h-auto min-h-9 justify-start whitespace-normal py-2 text-left"
                  onClick={() => store.selectStep(step.id)}
                >
                  {step.input.options.label ?? `Worker ${step.ordinal + 1}`} · {step.status} ·
                  Attempt {step.attempt}/6
                </Button>
              ))}
            </section>
            {store.step && <WorkflowWorkerDetail store={store} />}
            {run.result !== undefined && (
              <section aria-label="Workflow result">
                <h3 className="font-semibold">Result</h3>
                <MarkdownCodeBlock
                  code={JSON.stringify(run.result, null, 2)}
                  language="json"
                  meta=""
                  isIncomplete={false}
                />
              </section>
            )}
            {run.error && <Callout variant="error">{run.error}</Callout>}
            <section aria-label="Save workflow" className="grid gap-2">
              <h3 className="font-semibold">Save for reuse</h3>
              <Input
                aria-label="Workflow name"
                value={store.saveName}
                onChange={(event) => store.setSaveName(event.target.value)}
              />
              <Select
                aria-label="Save location"
                value={store.saveLocation}
                onChange={(event) =>
                  store.setSaveLocation(event.target.value === "personal" ? "personal" : "project")
                }
              >
                <option value="project">Project</option>
                <option value="personal">Personal</option>
              </Select>
              <Button
                variant="outline"
                disabled={
                  Boolean(store.pending) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(store.saveName)
                }
                onClick={() => void store.save()}
              >
                Save workflow
              </Button>
              {store.saved && (
                <Callout>
                  Saved to {store.saved.location}: {store.saved.path}
                </Callout>
              )}
            </section>
            {store.error && (
              <Callout variant="error" role="alert">
                {store.error}
              </Callout>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
});
