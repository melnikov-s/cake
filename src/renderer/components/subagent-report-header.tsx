import { useId, useState } from "react";
import type { SubagentReportOrigin } from "../../contracts/subagents/subagent-data";
import { subagentReportHeading } from "../lib/subagent-report-presentation";
import { MessageLabel } from "./ai-elements/message";
import { DisclosureTrigger } from "./ui/disclosure-trigger";

export function SubagentReportHeader({ report }: { report: SubagentReportOrigin }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="mb-2 space-y-1.5">
      <MessageLabel className="mb-0 text-foreground">
        <span role="heading" aria-level={3}>
          {subagentReportHeading(report)}
        </span>
        <span className="ml-2 font-normal text-muted-foreground">
          Worker {report.handleId.slice(0, 8)}
        </span>
      </MessageLabel>
      <DisclosureTrigger
        title="Assignment details"
        className="w-fit gap-3 text-muted-foreground"
        open={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
      />
      <div
        id={detailsId}
        hidden={!open}
        className="space-y-2 rounded-md border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground"
      >
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
    </div>
  );
}
