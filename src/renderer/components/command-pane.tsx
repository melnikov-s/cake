import { observer } from "r-state-tree/react";
import { Markdown } from "./ai-elements/markdown";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";
import { SessionTree } from "./session-tree";
import type { CompatibilityResource } from "../../ipc/session-contract";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { ExtensionUiStore } from "../stores/ExtensionUiStore";

const compatibilityResourceKinds: CompatibilityResource["kind"][] = [
  "extension",
  "skill",
  "prompt",
  "package",
];

export const CommandPane = observer(function CommandPane({
  store,
  extensionUi,
}: {
  store: ProjectWorkbenchStore;
  extensionUi: ExtensionUiStore;
}) {
  const commandPane = store.commandPaneStore;
  if (!commandPane.pane || !store.session) return null;
  const title =
    commandPane.pane === "tree"
      ? "Session tree"
      : commandPane.pane === "changelog"
        ? "Pi changelog"
        : "Pi resources";
  const resourceGroups =
    commandPane.pane === "resources"
      ? compatibilityResourceKinds.map((kind) => ({
          kind,
          resources: store.session!.compatibility.resources.filter((item) => item.kind === kind),
        }))
      : [];
  const diagnostics =
    commandPane.pane === "resources"
      ? [
          ...new Map(
            [
              ...store.session.compatibility.diagnostics,
              ...extensionUi.compatibilityDiagnostics,
            ].map((item) => [item.id, item]),
          ).values(),
        ]
      : [];
  return (
    <aside
      className="flex h-full w-full flex-col overflow-y-auto border-l border-border bg-card/40 p-6 max-[620px]:fixed max-[620px]:inset-x-0 max-[620px]:bottom-0 max-[620px]:top-[52px] max-[620px]:z-45 max-[620px]:border-l-0"
      aria-labelledby="command-pane-title"
    >
      <header className="mb-4 flex items-center justify-between">
        <div className="grid gap-1">
          <h2 id="command-pane-title" className="m-0 font-display text-base font-semibold">
            {title}
          </h2>
          {commandPane.pane === "tree" && (
            <span className="text-xs text-muted-foreground">
              Navigate or fork without rewriting Pi history
            </span>
          )}
          {commandPane.pane === "changelog" && (
            <span className="text-xs text-muted-foreground">
              Version history for this agent runtime
            </span>
          )}
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Close ${title}`}
            onClick={() => commandPane.close()}
          >
            Close
          </Button>
        </div>
      </header>
      {commandPane.pane === "tree" ? (
        store.session.tree.length > 0 ? (
          <SessionTree
            nodes={store.session.tree}
            onNavigate={(id) => void commandPane.navigateTo(id)}
            onFork={(id) => void store.sessionContinuationStore.forkAt(id)}
          />
        ) : (
          <p className="text-xs text-muted-foreground">This session has no branches yet.</p>
        )
      ) : commandPane.pane === "changelog" ? (
        commandPane.changelogLoading ? (
          <LoadingState label="Loading changelog" />
        ) : (
          <Markdown className="pi-changelog">
            {commandPane.changelogMarkdown || "No changelog entries found."}
          </Markdown>
        )
      ) : (
        <div className="grid gap-6">
          {diagnostics.length > 0 && (
            <section className="grid gap-2">
              <h3 className="m-0 text-xs font-medium text-muted-foreground">Diagnostics</h3>
              {diagnostics.map((item) => (
                <Callout
                  key={item.id}
                  variant={item.severity === "error" ? "error" : "warning"}
                  className="p-2.5"
                >
                  <strong className="text-xs">{item.method ?? item.source}</strong>
                  <span className="whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {item.message}
                    {item.path ? `\n${item.path}` : ""}
                  </span>
                </Callout>
              ))}
            </section>
          )}
          {resourceGroups.map((group) => (
            <section key={group.kind} className="grid gap-2">
              <h3 className="m-0 flex items-center gap-2 text-xs font-semibold capitalize text-foreground">
                {group.kind[0]!.toUpperCase() + group.kind.slice(1)}s{" "}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {group.resources.length}
                </span>
              </h3>
              {group.resources.length === 0 ? (
                <p className="m-0 text-xs text-muted-foreground">None discovered.</p>
              ) : (
                group.resources.map((resource) => (
                  <article
                    key={resource.id}
                    className="grid gap-1.5 rounded-lg border border-border bg-card p-3"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <strong className="text-xs">{resource.name}</strong>
                      <small className="text-[11px] text-muted-foreground">
                        {resource.scope} · {resource.origin}
                      </small>
                    </div>
                    {resource.description && (
                      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                        {resource.description}
                      </p>
                    )}
                    {resource.commands.length > 0 && (
                      <p className="m-0 text-xs text-muted-foreground">
                        <b className="font-semibold text-foreground">Commands</b>{" "}
                        {resource.commands.map((command) => `/${command}`).join(", ")}
                      </p>
                    )}
                    {resource.tools.length > 0 && (
                      <p className="m-0 text-xs text-muted-foreground">
                        <b className="font-semibold text-foreground">Tools</b>{" "}
                        {resource.tools.join(", ")}
                      </p>
                    )}
                    <code
                      title={resource.path}
                      className="truncate font-mono text-[10px] text-muted-foreground"
                    >
                      {resource.source}
                    </code>
                  </article>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
});
