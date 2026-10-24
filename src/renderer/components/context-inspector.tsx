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
  const status = usage ? store.status : undefined;
  const activeTokens = status?.totalTokens;
  const headerTokens = activeTokens ?? store.estimatedTokens;
  const summary = status?.lastSummary;
  const statistics: [string, string][] = status
    ? [
        ["Active", status.totalTokens.toLocaleString()],
        ["System", status.systemTokens.toLocaleString()],
        ["Memory", status.memoryTokens.toLocaleString()],
        ["Messages", status.messageTokens.toLocaleString()],
        ["Baseline", (status.systemTokens + status.memoryTokens).toLocaleString()],
        ["Limit", status.limitTokens.toLocaleString()],
        ["Model window", status.modelLimitTokens.toLocaleString()],
        [
          "Cache",
          {
            "likely-warm": "Likely warm",
            "likely-cold": "Likely cold",
            uncertain: "Uncertain",
            unknown: "Unknown",
          }[store.cache.state],
        ],
      ]
    : [];
  if (summary) {
    statistics.push(
      [
        "Last memory update",
        new Date(summary.completedAt).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        }),
      ],
      [
        "Memory change",
        `${summary.beforeTokens.toLocaleString()} → ${summary.afterTokens.toLocaleString()}`,
      ],
      [
        "Update reason",
        {
          limit: "Context limit",
          "cache-cold": "Cache cold",
          "cache-unknown": "Cache unknown",
          overflow: "Overflow",
        }[summary.reason],
      ],
    );
  }
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
                <DialogTitle className="text-[0.9375rem] font-medium">Context</DialogTitle>
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
              {status && (
                <div className="mb-3 border-b border-border px-2 pb-3">
                  <table
                    aria-label="Context statistics"
                    className="w-full table-fixed text-xs leading-6 [&_td]:py-0.5 [&_td]:text-right [&_td]:font-mono [&_td]:tabular-nums [&_th]:py-0.5 [&_th]:pr-4 [&_th]:text-left [&_th]:font-normal [&_th]:text-muted-foreground"
                  >
                    <tbody>
                      {statistics.map(([label, value]) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          <td>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
