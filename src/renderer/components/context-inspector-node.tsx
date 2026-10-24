import { useId } from "react";
import { observer } from "r-state-tree/react";
import type { ContextInspectionNode } from "../../contracts/conversations/context-inspection";
import type { ContextInspectorStore } from "../stores/ContextInspectorStore";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Callout } from "./ui/callout";
import { LoadingSpinner } from "./ui/loading-state";

export const ContextInspectorNode = observer(function ContextInspectorNode({
  node,
  store,
  historical = false,
}: {
  node: ContextInspectionNode;
  store: ContextInspectorStore;
  historical?: boolean;
}) {
  const contentId = useId();
  if (node.kind === "original")
    return (
      <figure className="my-4" title={node.source}>
        <figcaption className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          {node.title}
          <Badge variant="outline" size="xs">
            Original
          </Badge>
        </figcaption>
        <blockquote className="border-l-2 border-border pl-3">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
            {node.text}
          </pre>
        </blockquote>
      </figure>
    );
  const open = store.expanded.includes(node.id);
  const children = node.children ?? store.details[node.id];
  const error = store.detailErrors[node.id];
  const pending = store.pending.includes(node.id);
  const page = node.detail?.offset !== undefined;
  return (
    <section data-slot="context-source" data-source-id={node.id}>
      <DisclosureTrigger
        title={node.title}
        aria-label={node.title}
        aria-describedby={node.summaryDepth !== undefined ? `${contentId}-depth` : undefined}
        badge={
          node.kind === "summary" && node.summaryDepth !== undefined ? (
            <Badge
              id={`${contentId}-depth`}
              variant="accent"
              size="xs"
              className="mt-1 shrink-0 whitespace-nowrap"
            >
              Depth {node.summaryDepth}
            </Badge>
          ) : undefined
        }
        open={open}
        chevronPosition="start"
        wrapTitle
        aria-controls={open ? contentId : undefined}
        className="min-h-9 rounded-md px-2 py-2 text-sm font-normal leading-6 hover:bg-muted/50"
        onClick={() => store.toggle(node)}
      />
      {open && (
        <div id={contentId} className={page ? "pb-2" : "pb-2 pl-7"} title={node.source}>
          {node.text && (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7">
              {node.text}
            </pre>
          )}
          {pending && <LoadingSpinner label="Loading earlier detail" />}
          {error && (
            <Callout variant="error" role="alert">
              {error}
              <Button variant="ghost" size="sm" onClick={() => void store.loadDetail(node)}>
                Try again
              </Button>
            </Callout>
          )}
          {children && (
            <div className={!page && (historical || node.detail) ? "pl-3" : undefined}>
              {children.map((child) => (
                <ContextInspectorNode
                  key={child.id}
                  node={child}
                  store={store}
                  historical={historical || Boolean(node.detail)}
                />
              ))}
            </div>
          )}
          {((node.detail && children?.length === 0) ||
            (node.kind === "summary" && !node.detail && !children)) && (
            <p className="text-xs text-muted-foreground">Earlier detail is unavailable.</p>
          )}
        </div>
      )}
    </section>
  );
});
