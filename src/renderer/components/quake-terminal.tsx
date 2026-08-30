import { useEffect, useId, useState, type CSSProperties } from "react";
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
import { CloseIcon, TerminalIcon } from "@/components/ui/icons";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { TerminalView } from "@/components/ui/terminal-view";
import { cn } from "@/lib/utils";
import type { TerminalStore } from "../stores/TerminalStore";

export const QuakeTerminal = observer(function QuakeTerminal({ store }: { store: TerminalStore }) {
  const [height, setHeight] = useState(360);
  const resolutionTitleId = useId();
  const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.8));
  const style: CSSProperties = { height: Math.min(height, maxHeight) };
  const active = store.activeEntry;
  const target = store.activeTarget;

  useEffect(() => {
    if (!store.resolutionRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.cancelResolution();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [store, store.resolutionRequest]);

  return (
    <>
      <section
        className={cn(
          "fixed inset-x-0 top-0 z-[100] flex min-h-[220px] flex-col border-b border-border bg-background shadow-[0_20px_60px_-24px_hsl(var(--shadow)/0.7)] transition-transform duration-180 ease-out",
          store.open ? "translate-y-0" : "-translate-y-full pointer-events-none",
        )}
        style={style}
        aria-label="Terminal"
        aria-hidden={!store.open}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 pl-20 pr-2 [app-region:drag]">
          <TerminalIcon />
          <strong className="text-xs font-semibold">{active?.shell ?? "Terminal"}</strong>
          {target && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {target.kind === "project" ? target.workspacePath : "~"}
            </span>
          )}
          <span className="font-mono text-[10px] text-muted-foreground">⌘~</span>
          <IconButton tooltip="Hide terminal" onClick={() => store.hide()}>
            <CloseIcon size={16} />
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
                  <TerminalView
                    active={isActive && store.open}
                    onData={(data) => store.write(entry.key, data)}
                    onResize={(cols, rows) => store.resize(entry.key, cols, rows)}
                    subscribe={(listener) => store.subscribeData(entry.key, listener)}
                  />
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
          className="-bottom-[5px]"
          label="Resize terminal"
          value={height}
          min={220}
          max={maxHeight}
          edge="top"
          onChange={setHeight}
        />
      </section>
      {store.resolutionRequest && (
        <DialogBackdrop
          className="z-[110]"
          aria-labelledby={resolutionTitleId}
          onClose={() => store.cancelResolution()}
        >
          <Confirmation
            className="w-full max-w-md"
            state="requested"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <ConfirmationRequest>
              <ConfirmationTitle id={resolutionTitleId}>
                Resolve and stop running{" "}
                {store.resolutionRequest.runningProgramCount === 1 ? "program" : "programs"}?
              </ConfirmationTitle>
              <ConfirmationDescription>
                {store.resolutionRequest.runningProgramCount === 1
                  ? "This session’s terminal has a running program. Resolving it will stop the program and close the shell."
                  : `${store.resolutionRequest.runningProgramCount} sessions have running programs in their terminals. Resolving them will stop the programs and close the shells.`}
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction variant="outline" onClick={() => store.cancelResolution()}>
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void store.confirmResolution()}>
                  Resolve and stop
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </DialogBackdrop>
      )}
    </>
  );
});
