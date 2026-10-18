import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { ContextInspectorStore } from "../stores/ContextInspectorStore";
import { ContextInspectorNode } from "./context-inspector-node";
import { DialogBackdrop, DialogContent, DialogTitle } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { CloseIcon, ContextIcon, ReloadIcon } from "./ui/icons";
import { Callout } from "./ui/callout";
import { Button } from "./ui/button";
import { LoadingSpinner } from "./ui/loading-state";
import { ContextUsageButton } from "./ui/context-usage-button";
import { formatEstimatedContextTokens } from "../lib/context-token-estimate";

export const ContextInspector = observer(function ContextInspector({
  store,
  usage = false,
}: {
  store: ContextInspectorStore;
  usage?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const activeTokens = usage ? store.status?.totalTokens : undefined;
  const headerTokens = activeTokens ?? store.estimatedTokens;
  useEffect(() => () => store.close(), [store]);
  const close = () => {
    store.close();
    trigger.current?.focus();
  };
  return (
    <>
      {usage ? (
        <ContextUsageButton
          ref={trigger}
          system={store.status?.systemTokens}
          memory={store.status?.memoryTokens}
          messages={store.status?.messageTokens}
          total={store.status?.totalTokens}
          limit={store.status?.limitTokens}
          cacheState={store.cache.state}
          detail={store.usageTooltip}
          onClick={() => store.show()}
        />
      ) : (
        <IconButton ref={trigger} tooltip="Browse context" onClick={() => store.show()}>
          <ContextIcon />
        </IconButton>
      )}
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
              <div className="min-w-0">
                <DialogTitle className="text-[15px] font-medium">Context</DialogTitle>
                {headerTokens !== undefined && (
                  <p
                    className="mt-0.5 text-xs text-muted-foreground"
                    title={
                      activeTokens !== undefined
                        ? "Estimated active context, including instructions, tools, memory, messages and tool results. Browsing earlier originals does not add them."
                        : "Estimated total for current outline text at roughly 4 characters per token. Includes active summaries; excludes earlier detail and model-specific overhead. Serialized content is counted as text, not image token usage."
                    }
                  >
                    {formatEstimatedContextTokens(headerTokens)} ·{" "}
                    {activeTokens !== undefined ? "active context" : "current text"}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <IconButton
                  tooltip="Refresh context"
                  disabled={store.loading}
                  onClick={() => void store.refresh()}
                >
                  <ReloadIcon />
                </IconButton>
                <IconButton autoFocus tooltip="Close context" onClick={close}>
                  <CloseIcon />
                </IconButton>
              </div>
            </header>
            <div
              className="min-h-0 overflow-auto px-4 py-3"
              key={store.loading ? "loading" : "content"}
            >
              {usage && store.status && (
                <div className="mb-3 border-b border-border px-2 pb-3 text-xs leading-6 text-muted-foreground">
                  <p className="text-foreground">{store.activityLabel ?? store.nextSend}</p>
                  <p>
                    Active ≈{store.status.totalTokens.toLocaleString()} /{" "}
                    {store.status.limitTokens.toLocaleString()} tokens.
                  </p>
                  <p>
                    Sys ≈{store.status.systemTokens.toLocaleString()} · Mem ≈
                    {store.status.memoryTokens.toLocaleString()} · Msgs ≈
                    {store.status.messageTokens.toLocaleString()}
                  </p>
                  <p>
                    Baseline (system + memory): ≈
                    {(store.status.systemTokens + store.status.memoryTokens).toLocaleString()}{" "}
                    tokens.
                  </p>
                  <p>
                    Limit: the smaller of Settings (
                    {store.status.configuredLimitTokens.toLocaleString()}) and model window (
                    {store.status.modelLimitTokens.toLocaleString()}).
                  </p>
                  <p>
                    Cache {store.cache.state.replaceAll("-", " ")}. {store.cache.detail}
                  </p>
                  {store.status.lastSummary && (
                    <p>
                      Last memory update: ≈{store.status.lastSummary.beforeTokens.toLocaleString()}{" "}
                      → ≈{store.status.lastSummary.afterTokens.toLocaleString()} tokens ·{" "}
                      {store.status.lastSummary.reason.replaceAll("-", " ")}.
                    </p>
                  )}
                  <p>
                    Browsing earlier originals does not add them to the model context. Summaries can
                    omit detail.
                  </p>
                </div>
              )}
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
