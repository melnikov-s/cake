import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { CloseIcon, SplitDownIcon, SplitRightIcon } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";
import type {
  SessionLayoutNode,
  SessionLayoutStore,
  SessionPaneNode,
  SessionSplitAxis,
} from "../stores/SessionLayoutStore";

interface SessionSplitLayoutProps {
  store: SessionLayoutStore;
  node?: SessionLayoutNode;
  title(sessionId: string): string;
  headerClassName?(pane: SessionPaneNode): string | undefined;
  renderHeader(pane: SessionPaneNode): ReactNode;
  renderPane(pane: SessionPaneNode): ReactNode;
  onFocus(paneId: string): void;
  onSplit(axis: SessionSplitAxis): void;
  onClose(paneId: string): void;
}

export const SessionSplitLayout = observer(function SessionSplitLayout({
  store,
  node = store.layout,
  title,
  headerClassName,
  renderHeader,
  renderPane,
  onFocus,
  onSplit,
  onClose,
}: SessionSplitLayoutProps) {
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitSize, setSplitSize] = useState(1_000);

  useLayoutEffect(() => {
    if (!node || node.kind !== "split") return;
    const element = splitRef.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setSplitSize(node.axis === "x" ? bounds.width : bounds.height);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node]);

  if (!node) return null;
  if (node.kind === "pane") {
    const sessionId = node.history[node.historyCursor];
    if (!sessionId) return null;
    const pane = store.panes.find((candidate) => candidate.paneId === node.paneId);
    const focused = pane?.focused ?? false;
    const multiplePanes = store.panes.length > 1;
    return (
      <section
        data-slot="session-pane"
        data-pane-id={node.paneId}
        data-session-id={sessionId}
        data-focused={focused ? "true" : "false"}
        className={cn(
          "group/pane relative grid h-full min-h-0 min-w-0 grid-rows-[52px_minmax(0,1fr)] overflow-hidden border border-transparent bg-background",
          multiplePanes &&
            focused &&
            "border-accent/40 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_10%,transparent)]",
        )}
        onPointerDownCapture={() => onFocus(node.paneId)}
        onFocusCapture={() => onFocus(node.paneId)}
      >
        <header
          data-slot="workspace-header"
          className={cn(
            "relative flex h-[52px] min-w-0 items-center gap-3 overflow-hidden border-b border-border/65 px-5 [app-region:drag]",
            multiplePanes && "bg-muted/20",
            multiplePanes && focused && "bg-muted/35",
            headerClassName?.(node),
          )}
        >
          {multiplePanes && (
            <span className="grid size-5 shrink-0 place-items-center rounded bg-muted font-mono text-[10px] font-semibold text-muted-foreground">
              {pane?.number}
            </span>
          )}
          <strong className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {title(sessionId)}
          </strong>
          <div className="flex min-w-0 shrink-0 items-center gap-1 [app-region:no-drag]">
            {renderHeader(node)}
            <IconButton
              tooltip="Split right"
              disabled={!store.canSplit}
              onClick={() => onSplit("x")}
            >
              <SplitRightIcon />
            </IconButton>
            <IconButton
              tooltip="Split down"
              disabled={!store.canSplit}
              onClick={() => onSplit("y")}
            >
              <SplitDownIcon />
            </IconButton>
            {multiplePanes && (
              <IconButton tooltip="Close pane" onClick={() => onClose(node.paneId)}>
                <CloseIcon size={14} />
              </IconButton>
            )}
          </div>
        </header>
        <div className="h-full min-h-0 min-w-0 overflow-hidden">{renderPane(node)}</div>
      </section>
    );
  }

  const style: CSSProperties & Record<"--split-first" | "--split-second", string> = {
    "--split-first": `${node.ratio}fr`,
    "--split-second": `${1 - node.ratio}fr`,
  };
  const vertical = node.axis === "x";
  return (
    <div
      ref={splitRef}
      data-slot="session-split"
      data-axis={node.axis}
      className={cn(
        "grid h-full min-h-0 min-w-0 overflow-hidden",
        vertical
          ? "grid-cols-[minmax(0,var(--split-first))_9px_minmax(0,var(--split-second))]"
          : "grid-rows-[minmax(0,var(--split-first))_9px_minmax(0,var(--split-second))]",
      )}
      style={style}
    >
      <SessionSplitLayout
        {...{
          store,
          title,
          headerClassName,
          renderHeader,
          renderPane,
          onFocus,
          onSplit,
          onClose,
        }}
        node={node.first}
      />
      <div className="relative z-30 bg-border/35">
        <ResizeHandle
          className="inset-0 h-full w-full"
          label={vertical ? "Resize session columns" : "Resize session rows"}
          value={node.ratio * splitSize}
          min={splitSize * 0.2}
          max={splitSize * 0.8}
          edge={vertical ? "left" : "top"}
          onChange={(value) => store.setSplitRatio(node.splitId, value / splitSize)}
        />
      </div>
      <SessionSplitLayout
        {...{
          store,
          title,
          headerClassName,
          renderHeader,
          renderPane,
          onFocus,
          onSplit,
          onClose,
        }}
        node={node.second}
      />
    </div>
  );
});
