import { observer } from "r-state-tree/react";
import { Popover, PopoverContent, PopoverIconTrigger } from "@/components/ui/popover";
import {
  DiffIcon,
  EyeIcon,
  LogIcon,
  SparkleIcon,
  WorkLogCollapsedIcon,
  WorkLogFullyExpandedIcon,
  WorkLogSemiExpandedIcon,
} from "@/components/ui/icons";
import { SegmentedControlGroup, SegmentedControlButton } from "@/components/ui/segmented-control";
import type { ChatStore } from "../stores/ChatStore";

export const WorkLogControls = observer(function WorkLogControls({ store }: { store: ChatStore }) {
  const viewMode = store.workLogPresentation.viewMode;
  const expansion = store.workLogPresentation.expansion;

  return (
    <Popover>
      <PopoverIconTrigger data-cake-hint-key="w" tooltip="Work log display options">
        <EyeIcon />
      </PopoverIconTrigger>

      <PopoverContent
        aria-label="Work log display options"
        align="end"
        side="bottom"
        offset={6}
        className="w-80 p-2.5 shadow-lg"
      >
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
              className="transition-colors"
              active={viewMode === "auto"}
              aria-label="Auto view mode"
              onClick={() => store.workLogPresentation.setViewMode("auto")}
            >
              <SparkleIcon />
              <span className="ml-1">Auto</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              className="transition-colors"
              active={viewMode === "diff"}
              aria-label="Diff view mode"
              onClick={() => store.workLogPresentation.setViewMode("diff")}
            >
              <DiffIcon />
              <span className="ml-1">Diff</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              className="transition-colors"
              active={viewMode === "log"}
              aria-label="Log view mode"
              onClick={() => store.workLogPresentation.setViewMode("log")}
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
              className="transition-colors"
              active={expansion === "collapsed"}
              aria-label="Collapsed work logs"
              onClick={() => store.workLogPresentation.setExpansion("collapsed")}
            >
              <WorkLogCollapsedIcon />
              <span className="ml-1">Collapsed</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              className="transition-colors"
              active={expansion === "expanded"}
              aria-label="Compact work logs"
              onClick={() => store.workLogPresentation.setExpansion("expanded")}
            >
              <WorkLogSemiExpandedIcon />
              <span className="ml-1">Compact</span>
            </SegmentedControlButton>
            <SegmentedControlButton
              size="sm"
              className="transition-colors"
              active={expansion === "fully-expanded"}
              aria-label="Full work logs"
              onClick={() => store.workLogPresentation.setExpansion("fully-expanded")}
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
