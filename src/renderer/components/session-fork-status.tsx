import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";
import type { SessionContinuationStore } from "../stores/SessionContinuationStore";

export const SessionForkStatus = observer(function SessionForkStatus({
  store,
}: {
  store: SessionContinuationStore;
}) {
  const setup = store.forkSetup;
  if (!setup) return null;
  return (
    <div className="grid gap-2 px-3 py-2">
      {setup.error ? (
        <Callout variant="error" role="alert">
          <strong>Could not finish fork setup</strong>
          <span>{setup.error}</span>
          {setup.sessionId && <span>The fork exists. Retry resumes opening it.</span>}
          {!setup.sessionId && (
            <span>Backend changes may already exist. Retrying will request the fork again.</span>
          )}
          <Button size="sm" variant="outline" onClick={() => void store.retryFork()}>
            Retry fork setup
          </Button>
          <Button size="sm" variant="ghost" onClick={() => store.discardPreview()}>
            Discard preview
          </Button>
        </Callout>
      ) : (
        <LoadingState label="Preparing fork" />
      )}
      <Button size="sm" variant="ghost" onClick={() => store.returnToSource()}>
        Back to source
      </Button>
    </div>
  );
});
