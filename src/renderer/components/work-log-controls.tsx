import { observer } from "r-state-tree/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DiffIcon,
  LogIcon,
  SparkleIcon,
  WorkLogCollapsedIcon,
  WorkLogFullyExpandedIcon,
  WorkLogSemiExpandedIcon,
} from "@/components/ui/icons";
import { SegmentedControlGroup, SegmentedControlButton } from "@/components/ui/segmented-control";
import type { ChatStore } from "../stores/ChatStore";

export const WorkLogControls = observer(function WorkLogControls({ store }: { store: ChatStore }) {
  const viewMode = store.workLogViewMode;
  const expansion = store.workLogsExpansion;

  return (
    <Popover>
      <PopoverTrigger
        className="flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]"
        aria-label="Work log display options"
        title="Work log display options"
      >
        <span className="flex items-center gap-0.5">
          {viewMode === "auto" ? <SparkleIcon /> : viewMode === "diff" ? <DiffIcon /> : <LogIcon />}
          {expansion === "collapsed" ? (
            <WorkLogCollapsedIcon />
          ) : expansion === "expanded" ? (
            <WorkLogSemiExpandedIcon />
          ) : (
            <WorkLogFullyExpandedIcon />
          )}
        </span>
      </PopoverTrigger>

      <PopoverContent align="end" side="bottom" offset={6} className="w-56 p-2.5 shadow-lg">
        <section className="grid gap-1.5" aria-labelledby="work-log-view-mode-title">
          <header
            id="work-log-view-mode-title"
            className="text-xs font-medium text-muted-foreground"
          >
            View Mode
          </header>
          <SegmentedControlGroup
            size="sm"
            className="w-full grid grid-cols-3"
            aria-label="Work log view mode"
          >
            <SegmentedControlButton
              size="sm"
              active={viewMode === "auto"}
              aria-label="Auto view mode"
              onClick={() => store.setWorkLogViewMode("auto")}
            >
              <SparkleIcon />
              <span className="ml-1">Auto</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              active={viewMode === "diff"}
              aria-label="Diff view mode"
              onClick={() => store.setWorkLogViewMode("diff")}
            >
              <DiffIcon />
              <span className="ml-1">Diff</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              active={viewMode === "log"}
              aria-label="Log view mode"
              onClick={() => store.setWorkLogViewMode("log")}
            >
              <LogIcon />
              <span className="ml-1">Log</span>
            </SegmentedControlButton>
          </SegmentedControlGroup>
        </section>

        <div className="my-2 border-t border-border/70" />

        <section className="grid gap-1.5" aria-labelledby="work-log-expansion-title">
          <header
            id="work-log-expansion-title"
            className="text-xs font-medium text-muted-foreground"
          >
            Expansion
          </header>
          <SegmentedControlGroup
            size="sm"
            className="w-full grid grid-cols-3"
            aria-label="Work log expansion"
          >
            <SegmentedControlButton
              size="sm"
              active={expansion === "collapsed"}
              aria-label="Collapsed work logs"
              onClick={() => store.setWorkLogsExpansion("collapsed")}
            >
              <WorkLogCollapsedIcon />
              <span className="ml-1">Collapsed</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              active={expansion === "expanded"}
              aria-label="Compact work logs"
              onClick={() => store.setWorkLogsExpansion("expanded")}
            >
              <WorkLogSemiExpandedIcon />
              <span className="ml-1">Compact</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              active={expansion === "fully-expanded"}
              aria-label="Full work logs"
              onClick={() => store.setWorkLogsExpansion("fully-expanded")}
            >
              <WorkLogFullyExpandedIcon />
              <span className="ml-1">Full</span>
            </SegmentedControlButton>
          </SegmentedControlGroup>
        </section>
      </PopoverContent>
    </Popover>
  );
});
