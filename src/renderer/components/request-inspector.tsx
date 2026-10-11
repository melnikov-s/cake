import { observer } from "r-state-tree/react";
import { useMemo, useRef, useState } from "react";
import type { RequestInspectorStore } from "../stores/RequestInspectorStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Callout } from "./ui/callout";
import { DialogBackdrop, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { StructuredData } from "./ui/structured-data";
import { MarkdownCodeBlock, streamingCodeMarker } from "./ai-elements/markdown-code-block";

import { parseStructuredData } from "../lib/structured-data";

export const RequestInspector = observer(function RequestInspector({
  store,
}: {
  store: RequestInspectorStore;
}) {
  const [rawView, setRawView] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    store.close();
    trigger.current?.focus();
  };
  const payload = store.payload;
  const value = useMemo(
    () => (payload?.raw === undefined ? null : parseStructuredData(payload.raw)),
    [payload?.raw],
  );
  return (
    <>
      <Button
        ref={trigger}
        size="sm"
        variant="ghost"
        onClick={() => store.show()}
        aria-label="Inspect context"
      >
        Inspect context
      </Button>
      {store.open && (
        <DialogBackdrop
          onClose={close}
          aria-labelledby="request-inspector-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <DialogContent
            className="flex max-h-[90vh] max-w-[70rem] flex-col gap-3"
            data-cake-private-preview="true"
          >
            <div className="flex items-center justify-between gap-3">
              <DialogTitle id="request-inspector-title">Cake Chat · Inspect context</DialogTitle>
              <Button autoFocus variant="ghost" size="sm" onClick={close}>
                Close
              </Button>
            </div>
            <DialogDescription>
              Captured requests, not a fresh preview. HTTP bodies are captured after provider
              formatting and Fast mode, at Pi’s injected fetch boundary. Provider-internal prompts
              are not observable. Non-HTTP payloads are labelled intermediate, not exact.
            </DialogDescription>
            <p className="text-xs text-muted-foreground">
              Local backend memory only · last {store.history?.maxEntries ?? 40} captures, up to{" "}
              {Math.round((store.history?.maxBytes ?? 67108864) / 1048576)} MiB · lost on restart ·{" "}
              {store.history?.evicted ?? 0} evicted. Clear forgets captured bodies, not the
              conversation. Includes coordinator, compaction and memory-summary model calls.
            </p>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Captured request"
                value={payload?.entry.id ?? ""}
                onChange={(event) => void store.select(event.target.value)}
                disabled={store.loading || !store.history?.entries.length}
              >
                {!payload && (
                  <option value="">{store.loading ? "Loading…" : "Select a request"}</option>
                )}
                {[...(store.history?.entries ?? [])].reverse().map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.capturedAt} · {entry.provider}/{entry.modelId} · {entry.purpose} ·{" "}
                    {entry.boundary === "http-body"
                      ? `HTTP attempt ${entry.attempt}`
                      : "Intermediate payload"}{" "}
                    · {entry.state}
                  </option>
                ))}
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={store.loading}
                onClick={() => void store.refresh()}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={store.loading || !store.history?.entries.length}
                onClick={() => void store.clear()}
              >
                Clear history
              </Button>
            </div>
            {store.loading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading captured context…
              </p>
            )}
            {store.error && (
              <Callout variant="error" role="alert">
                {store.error}
              </Callout>
            )}
            {!store.loading && !store.error && !store.history?.entries.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No captured requests yet. Capture starts when this backend sends a Cake Chat model
                request; earlier calls cannot be reconstructed.
              </p>
            )}
            {payload && (
              <>
                <Callout
                  variant={
                    payload.entry.boundary === "http-body" && !payload.entry.limitation
                      ? "info"
                      : "warning"
                  }
                >
                  <strong>
                    {payload.entry.boundary === "http-body" && !payload.entry.limitation
                      ? "Exact serialized HTTP request body"
                      : "Intermediate or unavailable capture — NOT an exact outbound body"}
                  </strong>
                  {payload.entry.limitation && <p>{payload.entry.limitation}</p>}
                  <p className="break-all">
                    Request {payload.entry.id} · Call {payload.entry.callId} · {payload.entry.api} ·{" "}
                    {payload.entry.byteSize.toLocaleString()} bytes · {payload.entry.state}
                    {payload.entry.status === undefined ? "" : ` · HTTP ${payload.entry.status}`}
                  </p>
                  <p className="break-all">
                    Invocation settings (provider-adjusted settings remain in body):{" "}
                    {payload.entry.settings}
                  </p>
                </Callout>
                <div className="flex items-center gap-2">
                  <Input
                    autoFocus
                    aria-label="Search captured context"
                    placeholder="Search full captured payload…"
                    value={store.query}
                    onChange={(event) => store.setQuery(event.target.value)}
                  />
                  <Button variant="outline" size="sm" onClick={() => setRawView(!rawView)}>
                    {rawView ? "Structured view" : "Raw view"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={payload.raw === undefined}
                    onClick={() => void store.copy()}
                  >
                    Copy raw
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={payload.raw === undefined}
                    onClick={() => store.export()}
                  >
                    Export raw
                  </Button>
                </div>
                {store.notice && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {store.notice}
                  </p>
                )}
                {payload.raw !== undefined && (
                  <div className="min-h-0 overflow-auto rounded-lg border border-border p-3">
                    <p className="mb-3 text-xs text-muted-foreground">
                      {rawView
                        ? "Plain-text rendering of the captured string. Search is available in Structured view. Copy/export retain every byte of the captured UTF-8 JSON body."
                        : "Readable rendering, not the raw body. Search includes collapsed values; expand fields to read complete contents. Images are previews; base64 remains in raw export. Remote references are not fetched."}
                    </p>
                    {rawView ? (
                      <MarkdownCodeBlock
                        isIncomplete
                        code={payload.raw}
                        language="text"
                        meta={`${streamingCodeMarker} noLineNumbers preserveWhitespace`}
                      />
                    ) : (
                      <StructuredData
                        key={payload.entry.id}
                        value={value}
                        query={store.query}
                        showEmpty
                      />
                    )}
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
