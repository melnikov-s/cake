import { useEffect, useId } from "react";
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
}: {
  reference: ArtifactStableRef;
  label?: string;
  store: InlineArtifactPreviewStore;
  inlineWidgets: InlineWidgetStore;
}) {
  const key = useId();
  useEffect(() => {
    store.prepare(key, reference);
    return () => store.release(key);
  }, [key, reference, store]);
  const state = store.states[key];
  const exactRef = state?.exactRef ?? reference;
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
      open={state?.expanded ?? true}
      onToggle={() => store.toggle(key)}
    >
      {error ??
        (record ? (
          <ArtifactHost
            key={exactRef}
            record={record}
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
