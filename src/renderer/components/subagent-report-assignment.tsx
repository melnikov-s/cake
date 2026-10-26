import { useId, useState } from "react";
import type { SubagentReportOrigin } from "../../contracts/subagents/subagent-data";
import { DisclosureTrigger } from "./ui/disclosure-trigger";

/** The worker's assignment, collapsed above its findings; the card shows name and status. */
export function SubagentReportAssignment({ report }: { report: SubagentReportOrigin }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <div className="min-w-0">
      <DisclosureTrigger
        data-slot="assignment-disclosure"
        title="Assignment details"
        chevronPosition="start"
        className="w-fit rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        open={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div id={contentId} className="space-y-2 px-1.5 pt-1.5 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap break-words text-foreground">{report.task}</p>
          <dl className="space-y-1 break-words">
            <div>
              <dt className="inline font-medium">Worker: </dt>
              <dd className="inline">{report.handleId}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Scope: </dt>
              <dd className="inline">{report.projectPath ?? "General research"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Model: </dt>
              <dd className="inline">
                {report.resolvedModel.provider}/{report.resolvedModel.modelId}
                {report.fastMode ? " · Fast mode" : ""}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
