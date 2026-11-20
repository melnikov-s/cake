import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WidgetTabPicker } from "./widget-tab-picker";
import { IconSizeProvider } from "./ui/icon-size";
import { cn } from "../lib/utils";
import {
  chooseWorkspaceTabStage,
  workspaceTabPresentation,
  type MeasuredWorkspaceTabStage,
  type WorkspaceTabStage,
} from "../lib/workspace-tab-stage";

export interface WorkspaceTab {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect(): void;
  /** Accessible name in every stage; defaults to the label. */
  ariaLabel?: string;
  /** Tooltip; icon-only tabs fall back to the accessible name. */
  title?: string;
  /** Shown after the label at full width. */
  counts?: ReactNode;
  /** Compact counts shown beside the icon once the label collapses. */
  badges?: ReactNode;
}

const measuredStages: readonly MeasuredWorkspaceTabStage[] = ["full", "widget-icons", "icons"];

const tabClassName = (active: boolean, iconOnly: boolean) =>
  cn(
    "inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border text-xs whitespace-nowrap transition-colors outline-none select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
    iconOnly ? "gap-1 px-1.5" : "px-2.5",
    active
      ? "border-accent/35 bg-accent/15 font-semibold text-accent"
      : "border-transparent font-medium text-muted-foreground hover:bg-foreground/[0.055] hover:text-foreground",
  );

function TabRow({
  label,
  tabs,
  stage,
  measure = false,
}: {
  label: string;
  tabs: readonly WorkspaceTab[];
  stage: WorkspaceTabStage;
  measure?: boolean;
}) {
  const presentation = workspaceTabPresentation(stage);
  const iconOnly = presentation.builtIns === "icon";
  return (
    <>
      <div
        role={measure ? undefined : "group"}
        aria-label={measure ? undefined : label}
        // Last resort below the narrowest stage: clip at the edge, never under the widget menu.
        className="flex min-w-0 items-center gap-1.5 overflow-clip [overflow-clip-margin:4px]"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={tab.active}
            aria-label={iconOnly ? (tab.ariaLabel ?? tab.label) : tab.ariaLabel}
            title={iconOnly ? (tab.title ?? tab.ariaLabel ?? tab.label) : tab.title}
            tabIndex={measure ? -1 : undefined}
            onClick={measure ? undefined : tab.onSelect}
            className={tabClassName(tab.active, iconOnly)}
          >
            {iconOnly ? (
              <>
                <IconSizeProvider size="navigation">{tab.icon}</IconSizeProvider>
                {tab.badges}
              </>
            ) : (
              <>
                <span>{tab.label}</span>
                {tab.counts && <> {tab.counts}</>}
              </>
            )}
          </button>
        ))}
      </div>
      <WidgetTabPicker display={presentation.widget} measure={measure} />
    </>
  );
}

/**
 * Workspace tabs that collapse in stages as their pane narrows. Hidden rows hold
 * each stage's natural width, so the choice never depends on what is shown now.
 */
export function WorkspaceTabStrip({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly WorkspaceTab[];
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<WorkspaceTabStage>("full");
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const rows = new Map(
      measuredStages.map((stage) => [
        stage,
        strip.querySelector<HTMLElement>(`[data-measure-stage="${stage}"]`),
      ]),
    );
    const measure = () => {
      const available = strip.getBoundingClientRect().width;
      // Not laid out (hidden pane): keep the current stage until there is a width.
      if (available <= 0) return;
      const width = (stage: MeasuredWorkspaceTabStage) =>
        rows.get(stage)?.getBoundingClientRect().width ?? 0;
      const required = {
        full: width("full"),
        "widget-icons": width("widget-icons"),
        icons: width("icons"),
      };
      setStage((current) => chooseWorkspaceTabStage(available, required, current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const row of rows.values()) if (row) observer.observe(row);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={stripRef}
      data-slot="workspace-tab-strip"
      data-stage={stage}
      className="relative flex h-full min-w-0 flex-1 items-center justify-between gap-1.5 overflow-clip [overflow-clip-margin:4px]"
    >
      <TabRow label={label} tabs={tabs} stage={stage} />
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none invisible absolute top-0 left-0 h-0 overflow-visible"
      >
        {measuredStages.map((measured) => (
          <div
            key={measured}
            data-measure-stage={measured}
            className="absolute top-0 left-0 flex w-max items-center gap-1.5"
          >
            <TabRow label={label} tabs={tabs} stage={measured} measure />
          </div>
        ))}
      </div>
    </div>
  );
}
