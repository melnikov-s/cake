import { observer } from "r-state-tree/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ChevronIcon,
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
    <Popover>
      <PopoverTrigger
        className="header-pane-toggle work-log-popover-trigger"
        aria-label="Work log display options"
        title="Work log display options"
      >
        <span className="work-log-trigger-icons">
          {viewMode === "auto" ? <SparkleIcon /> : viewMode === "diff" ? <DiffIcon /> : <LogIcon />}
          {expansion === "collapsed" ? (
            <WorkLogCollapsedIcon />
          ) : expansion === "expanded" ? (
            <WorkLogSemiExpandedIcon />
          ) : (
            <WorkLogFullyExpandedIcon />
          )}
        </span>
        <ChevronIcon />
      </PopoverTrigger>

      <PopoverContent align="end" side="bottom" offset={6} className="work-log-popover-menu">
        <section className="work-log-popover-section" aria-labelledby="work-log-view-mode-title">
          <header id="work-log-view-mode-title" className="work-log-popover-heading">
            View Mode
          </header>
          <div className="work-log-segmented-group" role="group" aria-label="Work log view mode">
            <button
              type="button"
              className={`work-log-control-btn${viewMode === "auto" ? " active" : ""}`}
              aria-label="Auto view mode"
              aria-pressed={viewMode === "auto"}
              onClick={() => store.setWorkLogViewMode("auto")}
            >
              <SparkleIcon />
              <span>Auto</span>
            </button>
            <button
              type="button"
              className={`work-log-control-btn${viewMode === "diff" ? " active" : ""}`}
              aria-label="Diff view mode"
              aria-pressed={viewMode === "diff"}
              onClick={() => store.setWorkLogViewMode("diff")}
            >
              <DiffIcon />
              <span>Diff</span>
            </button>
            <button
              type="button"
              className={`work-log-control-btn${viewMode === "log" ? " active" : ""}`}
              aria-label="Log view mode"
              aria-pressed={viewMode === "log"}
              onClick={() => store.setWorkLogViewMode("log")}
            >
              <LogIcon />
              <span>Log</span>
            </button>
          </div>
        </section>

        <div className="work-log-popover-divider" />

        <section className="work-log-popover-section" aria-labelledby="work-log-expansion-title">
          <header id="work-log-expansion-title" className="work-log-popover-heading">
            Expansion
          </header>
          <div className="work-log-segmented-group" role="group" aria-label="Work log expansion">
            <button
              type="button"
              className={`work-log-control-btn${expansion === "collapsed" ? " active" : ""}`}
              aria-label="Collapsed work logs"
              aria-pressed={expansion === "collapsed"}
              onClick={() => store.setWorkLogsExpansion("collapsed")}
            >
              <WorkLogCollapsedIcon />
              <span>Collapsed</span>
            </button>
            <button
              type="button"
              className={`work-log-control-btn${expansion === "expanded" ? " active" : ""}`}
              aria-label="Compact work logs"
              aria-pressed={expansion === "expanded"}
              onClick={() => store.setWorkLogsExpansion("expanded")}
            >
              <WorkLogSemiExpandedIcon />
              <span>Compact</span>
            </button>
            <button
              type="button"
              className={`work-log-control-btn${expansion === "fully-expanded" ? " active" : ""}`}
              aria-label="Full work logs"
              aria-pressed={expansion === "fully-expanded"}
              onClick={() => store.setWorkLogsExpansion("fully-expanded")}
            >
              <WorkLogFullyExpandedIcon />
              <span>Full</span>
            </button>
          </div>
        </section>
      </PopoverContent>
    </Popover>
  );
});
