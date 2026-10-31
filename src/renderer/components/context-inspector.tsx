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
          manual: "Manual",
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
            className="flex max-h-[85vh] max-w-[38rem] flex-col overflow-hidden p-0 phone:overflow-hidden phone:p-0"
            data-slot="context-inspector"
            data-cake-private-preview="true"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border/65 bg-sidebar/30 px-4 py-3">
              <div className="min-w-0">
                <DialogTitle className="text-sm font-semibold text-foreground">Context</DialogTitle>
                {headerTokens !== undefined && (
                  <p
                    className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground"
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
                {store.supportsCompaction && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!store.canCompact}
                    onClick={() => void store.compact()}
                  >
                    {store.compacting ? "Compacting…" : "Compact now"}
                  </Button>
                )}
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
              className="min-h-0 space-y-3 overflow-auto px-4 py-3"
              key={store.loading ? "loading" : "content"}
            >
              {store.compacting && <LoadingSpinner label="Compacting memory" />}
              {store.compactionError && (
                <Callout variant="error" role="alert">
                  {store.compactionError}
                </Callout>
              )}
              {store.compactionComplete && (
                <p role="status" className="px-1 text-xs font-medium text-muted-foreground">
                  Compaction complete.
                </p>
              )}
              {status && (
                <div className="rounded-lg border border-border/75 bg-card/50 p-2">
                  <table
                    role="table"
                    aria-label="Context statistics"
                    className="block w-full text-xs"
                  >
                    <tbody role="rowgroup" className="grid grid-cols-2 gap-1.5 phone:grid-cols-1">
                      {statistics.map(([label, value]) => (
                        <tr
                          key={label}
                          role="row"
                          className="flex items-baseline justify-between gap-2 rounded-md border border-border/50 bg-muted/25 px-2.5 py-1.5"
                        >
                          <th
                            scope="row"
                            role="rowheader"
                            className="text-left font-normal text-muted-foreground"
                          >
                            {label}
                          </th>
                          <td
                            role="cell"
                            className="text-right font-mono font-medium tabular-nums text-foreground"
                          >
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {store.loading && <LoadingSpinner label="Loading context" />}
              {store.error && (
                <Callout variant="error" role="alert">
                  <span>{store.error}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => void store.refresh()}
                  >
                    Try again
                  </Button>
                </Callout>
              )}
              {!store.loading && !store.error && store.sources.length === 0 && (
                <p className="rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
                  No assembled context yet.
                </p>
              )}
              {store.sources.length > 0 && (
                <div className="space-y-1">
                  {store.sources.map((node) => (
                    <ContextInspectorNode key={node.id} node={node} store={store} />
                  ))}
                </div>
              )}
            </div>
          </DialogContent>
        </DialogBackdrop>
      )}
    </>
  );
});
