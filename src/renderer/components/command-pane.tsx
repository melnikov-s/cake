import { observer } from "r-state-tree/react";
import { Markdown } from "./ai-elements/markdown";
import { Button } from "./ui/button";
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
    <aside className="command-pane secondary-surface" aria-labelledby="command-pane-title">
      <header>
        <div>
          <h2 id="command-pane-title">{title}</h2>
          {commandPane.pane === "tree" && (
            <span>Navigate or fork without rewriting Pi history</span>
          )}
          {commandPane.pane === "changelog" && <span>Version history for this agent runtime</span>}
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
            onFork={(id) => void store.sessionForkStore.forkAt(id)}
          />
        ) : (
          <p>This session has no branches yet.</p>
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
        <div className="resource-catalog">
          {diagnostics.length > 0 && (
            <section className="resource-diagnostics">
              <h3>Diagnostics</h3>
              {diagnostics.map((item) => (
                <div key={item.id} className={`notice notice-${item.severity}`}>
                  <strong>{item.method ?? item.source}</strong>
                  <span>
                    {item.message}
                    {item.path ? `\n${item.path}` : ""}
                  </span>
                </div>
              ))}
            </section>
          )}
          {resourceGroups.map((group) => (
            <section key={group.kind}>
              <h3>
                {group.kind[0]!.toUpperCase() + group.kind.slice(1)}s{" "}
                <span>{group.resources.length}</span>
              </h3>
              {group.resources.length === 0 ? (
                <p>None discovered.</p>
              ) : (
                group.resources.map((resource) => (
                  <article key={resource.id}>
                    <div>
                      <strong>{resource.name}</strong>
                      <small>
                        {resource.scope} · {resource.origin}
                      </small>
                    </div>
                    {resource.description && <p>{resource.description}</p>}
                    {resource.commands.length > 0 && (
                      <p>
                        <b>Commands</b>{" "}
                        {resource.commands.map((command) => `/${command}`).join(", ")}
                      </p>
                    )}
                    {resource.tools.length > 0 && (
                      <p>
                        <b>Tools</b> {resource.tools.join(", ")}
                      </p>
                    )}
                    <code title={resource.path}>{resource.source}</code>
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
