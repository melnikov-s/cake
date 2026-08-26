import { observer } from "r-state-tree/react";
import { ArtifactHost } from "./artifact-host";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { SourceLocation } from "../../ipc/source-location";

export const ArtifactsPanel = observer(function ArtifactsPanel({
  session,
  inlineWidgets,
  onOpenSourceLocation,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const artifacts = session.artifactInteractionStore;
  const records = session.model.artifacts.map((artifact) => artifact.value);
  if (records.length === 0) return null;
  const linked = new Set(
    session.canonicalParts.flatMap((part) =>
      part.kind === "tool" && part.artifactId ? [part.artifactId] : [],
    ),
  );
  // Settled request artifacts belong to their branch-local transcript part and
  // must not float to the end of a different branch. A currently blocking
  // request may appear here briefly until its durable pointer is projected.
  const activeRequestId = artifacts.request?.record.artifact.id;
  const unlinked = records.filter(
    (record) =>
      !linked.has(record.artifact.id) &&
      (record.artifact.kind !== "request" || record.artifact.id === activeRequestId),
  );
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
            submittedAnswer={artifacts.submittedAnswer(record.artifact)}
            onSubmit={(value) => void artifacts.answer(record, value)}
            onSkip={() => void artifacts.respond(undefined, true)}
            inlineWidgets={inlineWidgets}
            onOpenSourceLocation={onOpenSourceLocation}
          />
        );
      })}
    </section>
  );
});
