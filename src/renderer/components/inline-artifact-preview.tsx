import { useContext, useEffect, useId } from "react";
import { InlineArtifactContext } from "./inline-artifact-context";
import { observer } from "r-state-tree/react";
import {
  parseArtifactRef,
  type ArtifactStableRef,
} from "../../contracts/artifacts/artifact-lineage";
import type { InlineArtifactPreviewStore } from "../stores/InlineArtifactPreviewStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { ArtifactHost } from "./artifact-host";
import { ArtifactDisclosure } from "./ui/artifact-disclosure";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";

export const InlineArtifactPreview = observer(function InlineArtifactPreview({
  reference,
  label,
  store,
  inlineWidgets,
  stateSessionId,
  surfaceId,
}: {
  reference: ArtifactStableRef;
  label?: string;
  store: InlineArtifactPreviewStore;
  inlineWidgets: InlineWidgetStore;
  stateSessionId?: string;
  surfaceId?: string;
}) {
  const key = useId();
  const context = useContext(InlineArtifactContext);
  const conversationId = context?.conversationId ?? stateSessionId;
  const presentationId = context ? `${context.partId}:${surfaceId ?? "publication"}` : surfaceId;
  useEffect(() => {
    store.prepare(key, reference, conversationId, presentationId);
    return () => store.release(key);
  }, [key, reference, store, conversationId, presentationId]);
  const state = store.states[key];
  const exactRef = state?.exactRef ?? state?.targetRef ?? reference;
  const title = label ?? store.title(key) ?? parseArtifactRef(reference).lineageId;
  const record = store.revision(key)?.record;
  const error = state?.error ? (
    <Callout variant="error" title="Unable to load inline preview">
      {state.error}
      <Button size="sm" variant="ghost" onClick={() => void store.load(key)}>
        Retry preview
      </Button>
    </Callout>
  ) : null;
  return (
    <ArtifactDisclosure
      title={title}
      reference={exactRef}
      oldVersion={store.isOldVersion(key)}
      open={store.expanded(key)}
      onToggle={() => store.toggle(key)}
    >
      {error ??
        (record ? (
          <ArtifactHost
            record={record}
            stateSessionId={stateSessionId}
            inlineWidgets={inlineWidgets}
            presentation="inline"
          />
        ) : (
          <div className="min-h-55" aria-busy="true">
            <LoadingState label={`Loading ${title}`} />
          </div>
        ))}
    </ArtifactDisclosure>
  );
});
