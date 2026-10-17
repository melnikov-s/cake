import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { ContextInspectorStore } from "../stores/ContextInspectorStore";
import { ContextInspectorNode } from "./context-inspector-node";
import { DialogBackdrop, DialogContent, DialogTitle } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { CloseIcon, ContextIcon, InfoIcon, ReloadIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { Callout } from "./ui/callout";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-state";

export const ContextInspector = observer(function ContextInspector({
  store,
}: {
  store: ContextInspectorStore;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => store.close(), [store]);
  const close = () => {
    store.close();
    trigger.current?.focus();
  };
  return (
    <>
      <IconButton ref={trigger} tooltip="Browse context" onClick={() => store.show()}>
        <ContextIcon />
      </IconButton>
      {store.open && (
        <DialogBackdrop
          aria-label="Context"
          onClose={close}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation();
              close();
            }
          }}
        >
          <DialogContent
            className="flex max-h-[85vh] max-w-[36rem] flex-col overflow-hidden p-0 phone:overflow-hidden phone:p-0"
            data-slot="context-inspector"
            data-cake-private-preview="true"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border bg-background px-5 py-3">
              <DialogTitle className="text-[15px] font-medium">Context</DialogTitle>
              <div className="flex items-center gap-1">
                <IconButton
                  tooltip="Refresh context"
                  disabled={store.loading}
                  onClick={() => void store.refresh()}
                >
                  <ReloadIcon />
                </IconButton>
                <Popover>
                  <PopoverIconTrigger tooltip="About this context">
                    <InfoIcon />
                  </PopoverIconTrigger>
                  <PopoverContent
                    side="bottom"
                    align="end"
                    className="max-w-72 text-xs leading-6 text-muted-foreground"
                  >
                    The assembled context when you opened this view. Providers may transform it
                    before sending. Opening earlier memory detail only changes what you see, not
                    what the agent receives. Instruction text comes from the included prompt, not a
                    fresh read of files.
                  </PopoverContent>
                </Popover>
                <IconButton autoFocus tooltip="Close context" onClick={close}>
                  <CloseIcon />
                </IconButton>
              </div>
            </header>
            <div
              className="min-h-0 overflow-auto px-4 py-3"
              key={store.loading ? "loading" : "content"}
            >
              {store.loading && <LoadingSpinner label="Loading context" />}
              {store.error && (
                <Callout variant="error" role="alert">
                  {store.error}
                  <Button variant="ghost" size="sm" onClick={() => void store.refresh()}>
                    Try again
                  </Button>
                </Callout>
              )}
              {!store.loading && !store.error && store.sources.length === 0 && (
                <p className="px-2 py-6 text-sm text-muted-foreground">No assembled context yet.</p>
              )}
              {store.sources.map((node) => (
                <ContextInspectorNode key={node.id} node={node} store={store} />
              ))}
            </div>
          </DialogContent>
        </DialogBackdrop>
      )}
    </>
  );
});
