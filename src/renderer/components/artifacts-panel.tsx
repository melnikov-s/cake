import { observer } from "r-state-tree/react";
import { ArtifactHost } from "./artifact-host";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

export const ArtifactsPanel = observer(function ArtifactsPanel({
  session,
  inlineWidgets,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
}) {
  const artifacts = session.artifactInteractionStore;
  const records = session.model.artifacts.map((artifact) => artifact.value);
  if (records.length === 0) return null;
  const linked = new Set(
    session.canonicalParts.flatMap((part) =>
      part.kind === "tool" && part.artifactId ? [part.artifactId] : [],
    ),
  );
  const unlinked = records.filter((record) => !linked.has(record.artifact.id));
  if (unlinked.length === 0) return null;
  return (
    <section className="artifacts-panel" aria-label="Session artifacts">
      {unlinked.map((record) => {
        const request =
          artifacts.request?.record.artifact.id === record.artifact.id
            ? artifacts.request
            : undefined;
        return (
          <ArtifactHost
            key={record.artifact.id}
            record={record}
            requested={Boolean(request)}
            onSubmit={(value) => void artifacts.answer(record, value)}
            onSkip={() => void artifacts.respond(undefined, true)}
            inlineWidgets={inlineWidgets}
          />
        );
      })}
    </section>
  );
});
