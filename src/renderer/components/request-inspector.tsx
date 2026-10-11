import { observer } from "r-state-tree/react";
import { useEffect, useMemo, useRef } from "react";
import type { RequestInspectorStore } from "../stores/RequestInspectorStore";
import { IconButton } from "./ui/icon-button";
import { CheckIcon, CloseIcon, CopyIcon, InspectIcon } from "./ui/icons";
import { Callout } from "./ui/callout";
import { DialogBackdrop, DialogContent, DialogTitle } from "./ui/dialog";
import { ReadableData } from "./ui/readable-data";
import { LoadingSpinner } from "./ui/loading-state";
import { parseStructuredData } from "../lib/structured-data";
import { requestContextSections } from "../lib/request-context";

export const RequestInspector = observer(function RequestInspector({
  store,
}: {
  store: RequestInspectorStore;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => store.close(), [store]);
  const close = () => {
    store.close();
    trigger.current?.focus();
  };
  const payload = store.payload;
  const sections = useMemo(
    () =>
      payload?.raw === undefined ? [] : requestContextSections(parseStructuredData(payload.raw)),
    [payload?.raw],
  );
  const error = store.error ?? store.copyError;
  return (
    <>
      <IconButton ref={trigger} tooltip="Inspect context" onClick={() => store.show()}>
        <InspectIcon />
      </IconButton>
      {store.open && (
        <DialogBackdrop
          onClose={close}
          aria-labelledby="request-inspector-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <DialogContent
            className="flex max-h-[90vh] max-w-[54rem] flex-col gap-6"
            data-cake-private-preview="true"
          >
            <div className="flex items-center justify-between gap-3">
              <DialogTitle id="request-inspector-title">Context</DialogTitle>
              <div className="flex items-center gap-1">
                <IconButton
                  ariaLabel="Copy raw context"
                  tooltip={store.copied ? "Copied" : "Copy raw context"}
                  disabled={payload?.raw === undefined}
                  onClick={() => void store.copy()}
                >
                  {store.copied ? <CheckIcon /> : <CopyIcon />}
                </IconButton>
                <IconButton autoFocus tooltip="Close" onClick={close}>
                  <CloseIcon />
                </IconButton>
              </div>
            </div>
            {store.copied && (
              <span role="status" className="sr-only">
                Raw context copied
              </span>
            )}
            {store.loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoadingSpinner label="Loading context" />
                <p>Loading context…</p>
              </div>
            )}
            {error && (
              <Callout variant="error" role="alert">
                {error}
              </Callout>
            )}
            {!store.loading && !store.error && !payload && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No captured context yet.
              </p>
            )}
            {payload && (
              <>
                {(payload.entry.boundary !== "http-body" ||
                  payload.entry.limitation ||
                  payload.raw === undefined) && (
                  <Callout variant="warning">
                    {payload.entry.boundary !== "http-body"
                      ? "Intermediate capture, not the exact outbound request. "
                      : ""}
                    {payload.entry.limitation ??
                      (payload.raw === undefined ? "The request body was not retained." : "")}
                  </Callout>
                )}
                {payload.raw !== undefined && (
                  <div className="min-h-0 space-y-6 overflow-auto" key={payload.entry.id}>
                    {sections.map((section, index) => (
                      <ReadableData
                        key={index}
                        title={section.title}
                        value={section.value}
                        defaultOpen={section.defaultOpen}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </DialogContent>
        </DialogBackdrop>
      )}
    </>
  );
});
