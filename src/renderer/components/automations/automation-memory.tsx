import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { LoadingState } from "../ui/loading-state";
import { ReadableData } from "../ui/readable-data";

export const AutomationMemory = observer(function AutomationMemory() {
  const memory = useStore(RootStore).automationsStore.memory;
  const current = memory.current;
  return (
    <section className="min-h-0 flex-1 overflow-auto px-8 py-7" aria-label="Automation memory">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold">Memory</h2>
          <div className="flex gap-2">
            {memory.path.length > 0 && (
              <Button variant="outline" onClick={() => memory.back()}>
                Back
              </Button>
            )}
            <Button variant="outline" disabled={memory.loading} onClick={() => void memory.load()}>
              Refresh
            </Button>
          </div>
        </header>
        <div className="my-6 flex flex-wrap gap-5 text-xs text-muted-foreground">
          <span>
            {memory.view?.bytes ?? 0} / {memory.view?.budgetBytes ?? 10000} bytes visible
          </span>
          <span>{memory.view?.sourceCount ?? 0} originals</span>
        </div>
        {memory.error && (
          <Callout variant="error" role="alert">
            {memory.error}
          </Callout>
        )}
        {memory.loading && <LoadingState label="Reading memory" />}
        <div className="border-t border-border/65">
          {memory.lines.map((line) => (
            <div
              key={`${line.range.id}:${line.range.n}`}
              className="flex items-start gap-3 border-b border-border/65 py-4 text-sm"
            >
              <span className="rounded-sm bg-muted px-1 font-mono text-xs text-muted-foreground">
                {line.range.id}+{line.range.n}
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">{line.text}</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={memory.loading}
                onClick={() => void memory.zoom(line.range)}
              >
                Zoom
              </Button>
            </div>
          ))}
        </div>
        {current?.zoom._tag === "Original" && (
          <div className="mt-5 rounded-lg border border-border/75 p-4">
            <h3 className="mb-3 text-xs text-muted-foreground">
              Original · {current.zoom.sourceId}
            </h3>
            <ReadableData value={current.zoom.text} />
            {current.zoom.nextOffset !== null && (
              <Button
                className="mt-4"
                variant="outline"
                disabled={memory.loading}
                onClick={() => void memory.loadMoreOriginal()}
              >
                Load more original
              </Button>
            )}
          </div>
        )}
        {!memory.loading && memory.view?.sourceCount === 0 && (
          <p className="py-8 text-sm text-muted-foreground">No memory entries yet.</p>
        )}
      </div>
    </section>
  );
});
