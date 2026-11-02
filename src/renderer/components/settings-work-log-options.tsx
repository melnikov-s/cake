import { observer } from "r-state-tree/react";
import {
  DiffIcon,
  LogIcon,
  SparkleIcon,
  WorkLogCollapsedIcon,
  WorkLogFullyExpandedIcon,
  WorkLogSemiExpandedIcon,
} from "@/components/ui/icons";
import { SegmentedControlGroup, SegmentedControlButton } from "@/components/ui/segmented-control";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const SettingsWorkLogOptions = observer(function SettingsWorkLogOptions({
  appearance,
}: {
  appearance: AppearanceSettingsStore;
}) {
  const viewMode = appearance.workLogViewMode;
  const expansion = appearance.workLogsExpansion;

  return (
    <section
      id="setting-work-log-display"
      aria-label="Work log display options"
      className="grid scroll-mt-8 gap-3 px-3.5 py-3"
    >
      <h3 className="text-xs font-medium">Work logs</h3>
      <section className="grid gap-1.5" aria-labelledby="work-log-view-mode-title">
        <header id="work-log-view-mode-title" className="text-xs font-medium text-muted-foreground">
          View Mode
        </header>
        <SegmentedControlGroup
          size="sm"
          className="w-fit max-w-full flex-wrap"
          aria-label="Work log view mode"
        >
          <SegmentedControlButton
            size="sm"
            active={viewMode === "auto"}
            aria-label="Auto view mode"
            onClick={() => appearance.setWorkLogViewMode("auto")}
          >
            <SparkleIcon />
            <span className="ml-1">Auto</span>
          </SegmentedControlButton>
          <SegmentedControlButton
            size="sm"
            active={viewMode === "diff"}
            aria-label="Diff view mode"
            onClick={() => appearance.setWorkLogViewMode("diff")}
          >
            <DiffIcon />
            <span className="ml-1">Diff</span>
          </SegmentedControlButton>
          <SegmentedControlButton
            size="sm"
            active={viewMode === "log"}
            aria-label="Log view mode"
            onClick={() => appearance.setWorkLogViewMode("log")}
          >
            <LogIcon />
            <span className="ml-1">Log</span>
          </SegmentedControlButton>
        </SegmentedControlGroup>
      </section>

      <div className="my-2 border-t border-border/70" />

      <section className="grid gap-1.5" aria-labelledby="work-log-expansion-title">
        <header id="work-log-expansion-title" className="text-xs font-medium text-muted-foreground">
          Expansion
        </header>
        <SegmentedControlGroup
          size="sm"
          className="w-fit max-w-full flex-wrap"
          aria-label="Work log expansion"
        >
          <SegmentedControlButton
            size="sm"
            active={expansion === "collapsed"}
            aria-label="Collapsed work logs"
            onClick={() => appearance.setWorkLogsExpansion("collapsed")}
          >
            <WorkLogCollapsedIcon />
            <span className="ml-1">Collapsed</span>
          </SegmentedControlButton>
          <SegmentedControlButton
            size="sm"
            active={expansion === "expanded"}
            aria-label="Compact work logs"
            onClick={() => appearance.setWorkLogsExpansion("expanded")}
          >
            <WorkLogSemiExpandedIcon />
            <span className="ml-1">Compact</span>
          </SegmentedControlButton>
          <SegmentedControlButton
            size="sm"
            active={expansion === "fully-expanded"}
            aria-label="Full work logs"
            onClick={() => appearance.setWorkLogsExpansion("fully-expanded")}
          >
            <WorkLogFullyExpandedIcon />
            <span className="ml-1">Full</span>
          </SegmentedControlButton>
        </SegmentedControlGroup>
      </section>
    </section>
  );
});
