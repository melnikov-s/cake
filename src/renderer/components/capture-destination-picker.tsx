import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { AppSidebar } from "./app-sidebar";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { CloseIcon, ChevronDownIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** The native editor returns pixels; this owning window composes its actual live sidebar. */
export const CaptureDestinationPicker = observer(function CaptureDestinationPicker() {
  const root = useStore(RootStore);
  const capture = root.screenCaptureStore;
  if (!capture.pendingCapture || capture.cakeChatOnly) return null;
  const current = capture.currentDestination;
  return (
    <div className="fixed top-14 left-1/2 z-50 -translate-x-1/2">
      <Popover defaultOpen>
        <PopoverTrigger aria-label="Screenshot destination" variant="outline" size="sm">
          Screenshot destination <ChevronDownIcon />
        </PopoverTrigger>
        <PopoverContent
          aria-label="Screenshot destination"
          align="center"
          className="flex w-80 max-h-[min(32rem,calc(100dvh-8rem))] flex-col overflow-hidden bg-sidebar p-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/65 p-2">
            {current && (
              <Button
                variant="ghost"
                size="sm"
                disabled={capture.busy}
                onClick={() => void capture.attachTo(current)}
              >
                Attach to current chat
              </Button>
            )}
            <IconButton
              className="ml-auto"
              tooltip="Cancel screenshot attachment"
              disabled={capture.busy}
              onClick={() => capture.cancelDestination()}
            >
              <CloseIcon />
            </IconButton>
          </div>
          <div className="flex min-h-0 flex-1 flex-col" inert={capture.busy}>
            <AppSidebar onSelectDestination={(destination) => void capture.attachTo(destination)} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});
