import { Button } from "./ui/button";
import { Callout } from "./ui/callout";

/** An unknown first-turn receipt is never retried without an explicit user decision. */
export function SavedDraftRecovery({ recover, disabled }: { recover(): void; disabled: boolean }) {
  return (
    <Callout variant="warning">
      This saved Draft may already have started. Check the session transcript before retrying; a
      first turn can be accepted before it appears in the catalog. If no turn was accepted, you can
      release the claim and activate it again.
      <Button variant="outline" disabled={disabled} onClick={recover}>
        I checked — no turn was accepted
      </Button>
    </Callout>
  );
}
