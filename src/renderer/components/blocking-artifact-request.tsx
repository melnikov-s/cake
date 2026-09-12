import { observer } from "r-state-tree/react";
import { ArtifactHost } from "@/components/artifact-host";
import type { SourceLocation } from "../../ipc/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

/** Keeps a not-yet-projected blocking request usable beside the active composer. */
export const BlockingArtifactRequest = observer(function BlockingArtifactRequest({
  session,
  inlineWidgets,
  onOpenSourceLocation,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const interaction = session.artifactInteractionStore;
  const request = interaction.request;
  if (!request) return null;
  const linked = session.canonicalParts.some(
    (part) => part.kind === "tool" && part.artifactId === request.record.artifact.id,
  );
  if (linked) return null;
  return (
    <div className="max-h-[min(50vh,28rem)] overflow-auto px-1 pb-2">
      <ArtifactHost
        record={request.record}
        requested
        submittedAnswer={interaction.submittedAnswer(request.record.artifact)}
        onSubmit={(value) => void interaction.answer(request.record, value)}
        onSkip={() => void interaction.respond(undefined, true)}
        inlineWidgets={inlineWidgets}
        onOpenSourceLocation={onOpenSourceLocation}
      />
    </div>
  );
});
