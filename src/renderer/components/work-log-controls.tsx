import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import {
  DiffIcon,
  LogIcon,
  SparkleIcon,
  WorkLogCollapsedIcon,
  WorkLogFullyExpandedIcon,
  WorkLogSemiExpandedIcon,
} from "@/components/ui/icons";
import type { ChatStore } from "../stores/ChatStore";

export const WorkLogControls = observer(function WorkLogControls({ store }: { store: ChatStore }) {
  const viewMode = store.workLogViewMode;
  const expansion = store.workLogsExpansion;

  return (
    <div className="work-log-header-controls" role="toolbar" aria-label="Work log display options">
      <div className="work-log-segmented-group" role="group" aria-label="Work log content">
        <IconButton
          className={`work-log-control-btn${viewMode === "auto" ? " active" : ""}`}
          tooltip="Auto: Diff if file changes, otherwise Log (⌃⇧O / ⌘⇧O)"
          ariaLabel="Auto view mode"
          aria-pressed={viewMode === "auto"}
          onClick={() => store.setWorkLogViewMode("auto")}
        >
          <SparkleIcon />
        </IconButton>
        <IconButton
          className={`work-log-control-btn${viewMode === "diff" ? " active" : ""}`}
          tooltip="Diffs only (⌃⇧O / ⌘⇧O)"
          ariaLabel="Diff view mode"
          aria-pressed={viewMode === "diff"}
          onClick={() => store.setWorkLogViewMode("diff")}
        >
          <DiffIcon />
        </IconButton>
        <IconButton
          className={`work-log-control-btn${viewMode === "log" ? " active" : ""}`}
          tooltip="Work log tool calls & reasoning (⌃⇧O / ⌘⇧O)"
          ariaLabel="Log view mode"
          aria-pressed={viewMode === "log"}
          onClick={() => store.setWorkLogViewMode("log")}
        >
          <LogIcon />
        </IconButton>
      </div>

      <div className="work-log-segmented-group" role="group" aria-label="Work log expansion">
        <IconButton
          className={`work-log-control-btn${expansion === "collapsed" ? " active" : ""}`}
          tooltip="Collapsed summary (⌃O / ⌘O)"
          ariaLabel="Collapse work logs"
          aria-pressed={expansion === "collapsed"}
          onClick={() => store.setWorkLogsExpansion("collapsed")}
        >
          <WorkLogCollapsedIcon />
        </IconButton>
        <IconButton
          className={`work-log-control-btn${expansion === "expanded" ? " active" : ""}`}
          tooltip="Semi-expanded (item headers) (⌃O / ⌘O)"
          ariaLabel="Semi-expand work logs"
          aria-pressed={expansion === "expanded"}
          onClick={() => store.setWorkLogsExpansion("expanded")}
        >
          <WorkLogSemiExpandedIcon />
        </IconButton>
        <IconButton
          className={`work-log-control-btn${expansion === "fully-expanded" ? " active" : ""}`}
          tooltip="Fully expanded (all details) (⌃O / ⌘O)"
          ariaLabel="Fully expand work logs"
          aria-pressed={expansion === "fully-expanded"}
          onClick={() => store.setWorkLogsExpansion("fully-expanded")}
        >
          <WorkLogFullyExpandedIcon />
        </IconButton>
      </div>
    </div>
  );
});
