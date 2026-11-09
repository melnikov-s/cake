import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { observer } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import { DialogBackdrop } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import {
  CloseIcon,
  DockBottomIcon,
  MoveTopIcon,
  PlusIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { tabFocusClassName, tabSurfaceClassName } from "@/components/ui/tab-styles";
import { cn } from "@/lib/utils";
import type { TerminalStore } from "../stores/TerminalStore";
import type { WorkingDirectoryRetirementStore } from "../stores/WorkingDirectoryRetirementStore";

const TerminalView = lazy(() =>
  import("@/components/ui/terminal-view").then((module) => ({ default: module.TerminalView })),
);

export const QuakeTerminal = observer(function QuakeTerminal({
  store,
  retirement,
}: {
  store: TerminalStore;
  retirement: WorkingDirectoryRetirementStore;
}) {
  const [height, setHeight] = useState(360);
  const panelRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // offsetHeight ignores the slide animation. Include the resize handle's
    // protruding hit area so the native view cannot intercept its pointer events.
    const measure = () => store.setMeasuredOverlayHeight(panel.offsetHeight + 5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      store.setMeasuredOverlayHeight(0);
    };
  }, [store]);
  const resolutionTitleId = useId();
  const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.8));
  const style: CSSProperties = { height: Math.min(height, maxHeight) };
  const active = store.activeEntry;
  const target = store.activeTarget;

  useEffect(() => {
    if (!retirement.confirmationRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") retirement.cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [retirement, retirement.confirmationRequest]);

  return (
    <>
      <section
        ref={panelRef}
        className={cn(
          "flex min-h-[220px] flex-col bg-background phone:!hidden",
          store.docked
            ? "relative z-30 w-full border-t border-border"
            : "fixed inset-x-0 top-0 z-[100] border-b border-border shadow-[0_20px_60px_-24px_hsl(var(--shadow)/0.7)] transition-transform duration-180 ease-out",
          store.open
            ? "translate-y-0"
            : store.docked
              ? "hidden"
              : "-translate-y-full pointer-events-none",
        )}
        style={style}
        aria-label="Terminal"
        aria-hidden={!store.open}
      >
        <header
          className={cn(
            "flex shrink-0 items-center gap-1 border-b border-border/70 pr-2 [app-region:drag]",
            // At the top this header is the window's title bar. Its content box is the title
            // bar height (border outside) so every control centers on the traffic lights, and
            // pl-24 leaves the same 18px after the zoom button as the lights' left inset.
            store.docked ? "h-10 pl-2" : "box-content h-title-bar pl-24",
          )}
        >
          <span className="grid shrink-0 place-items-center text-muted-foreground">
            <TerminalIcon size={18} />
          </span>
          {target && (
            <span
              className="mr-2 max-w-52 shrink-0 truncate text-xs font-medium text-foreground"
              title={target.workingDirectory}
            >
              Terminal · {target.label}
            </span>
          )}
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 [app-region:no-drag]"
            role="tablist"
            aria-label="Terminal tabs"
          >
            {store.activeEntries.map((entry, index) => {
              const isActive = entry.key === active?.key;
              const label = entry.shell ?? (entry.opening ? "Starting…" : "Terminal");
              return (
                <div
                  key={entry.key}
                  className={cn(
                    "flex min-w-0 max-w-56 shrink-0 items-center",
                    tabSurfaceClassName(isActive),
                  )}
                >
                  <Button
                    className={cn(
                      "h-7 min-w-0 rounded-sm px-2 font-mono text-xs text-inherit hover:bg-transparent hover:text-inherit active:scale-100",
                      tabFocusClassName,
                      isActive && "font-semibold",
                    )}
                    variant="ghost"
                    size="sm"
                    role="tab"
                    aria-selected={isActive}
                    title={label}
                    onClick={() => store.activate(entry.key)}
                  >
                    <span className="truncate">
                      {label}
                      {store.activeEntries.length > 1 ? ` ${index + 1}` : ""}
                    </span>
                  </Button>
                  {isActive && store.activeEntries.length > 1 && (
                    <IconButton
                      iconSize="inline"
                      className="mr-0.5 size-6"
                      tooltip={`Close ${label} tab`}
                      onClick={() => void store.closeTab(entry.key)}
                    >
                      <CloseIcon size={16} />
                    </IconButton>
                  )}
                </div>
              );
            })}
            <IconButton
              className="size-7 shrink-0"
              tooltip="New terminal tab"
              hotkey="new-terminal-tab"
              disabled={!target}
              onClick={() => void store.newTab()}
            >
              <PlusIcon size={18} />
            </IconButton>
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {store.toggleAcceleratorHint}
          </span>
          {store.docked ? (
            <IconButton tooltip="Move terminal to top" onClick={() => store.moveToTop()}>
              <MoveTopIcon size={18} />
            </IconButton>
          ) : (
            <IconButton tooltip="Pin terminal to bottom" onClick={() => store.dock()}>
              <DockBottomIcon size={18} />
            </IconButton>
          )}
          <IconButton tooltip="Hide terminal" hotkey="toggle-terminal" onClick={() => store.hide()}>
            <CloseIcon size={18} />
          </IconButton>
        </header>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-background px-2 pb-2 pt-1">
          {store.entries.map((entry) => {
            const isActive = entry.key === active?.key;
            return (
              <div
                key={entry.key}
                className={cn(
                  "absolute inset-x-2 bottom-2 top-1",
                  isActive ? "visible" : "invisible pointer-events-none",
                )}
                aria-hidden={!isActive}
              >
                {entry.terminalId || entry.opening ? (
                  <Suspense
                    fallback={
                      <div className="grid h-full place-items-center">
                        <LoadingState label="Opening terminal" />
                      </div>
                    }
                  >
                    <TerminalView
                      active={isActive && store.open}
                      onData={(data) => store.write(entry.key, data)}
                      onNewTab={() => void store.newTab()}
                      newTabHotkey={store.newTabHotkey}
                      onResize={(cols, rows) => store.resize(entry.key, cols, rows)}
                      subscribe={(listener) => store.subscribeData(entry.key, listener)}
                    />
                  </Suspense>
                ) : entry.error ? (
                  <div className="grid h-full place-items-center content-center gap-3 text-sm text-muted-foreground">
                    <span>{entry.error}</span>
                    <Button size="sm" onClick={() => void store.restart(entry.key, 80, 24)}>
                      Restart shell
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <ResizeHandle
          className={store.docked ? "-top-[5px]" : "-bottom-[5px]"}
          label="Resize terminal"
          value={height}
          min={220}
          max={maxHeight}
          edge={store.docked ? "bottom" : "top"}
          onChange={setHeight}
        />
      </section>
      {retirement.confirmationRequest && (
        <DialogBackdrop
          className="z-[110]"
          aria-labelledby={resolutionTitleId}
          onClose={() => retirement.cancel()}
        >
          <Confirmation
            className="w-full max-w-md"
            state="requested"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ConfirmationRequest>
              <ConfirmationTitle id={resolutionTitleId}>
                Retire and stop running{" "}
                {retirement.confirmationRequest.runningProgramCount === 1 ? "program" : "programs"}?
              </ConfirmationTitle>
              <ConfirmationDescription>
                {retirement.confirmationRequest.runningProgramCount === 1
                  ? "This Working Directory has a running terminal program. Continuing will stop it and close this directory’s terminals in every Cake window."
                  : `These Working Directories have ${retirement.confirmationRequest.runningProgramCount} running terminal programs across Cake windows. Continuing will stop them and close those directories’ terminals in every window.`}
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction variant="outline" onClick={() => retirement.cancel()}>
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void retirement.confirm()}>
                  Continue and stop
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </DialogBackdrop>
      )}
    </>
  );
});
