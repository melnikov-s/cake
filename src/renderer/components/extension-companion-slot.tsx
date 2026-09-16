import { observer } from "r-state-tree/react";
import type { JsonValue } from "../../ipc/json-contract";
import type { ExtensionCompanionProjection } from "../models/ExtensionUi";
import { ExtensionCompanionContribution } from "./extension-companion-contribution";

export const ExtensionCompanionSlot = observer(function ExtensionCompanionSlot({
  companions,
  slot,
  onAction,
}: {
  readonly companions: readonly ExtensionCompanionProjection[];
  readonly slot: ExtensionCompanionProjection["slot"];
  readonly onAction: (companionId: string, action: string, value: JsonValue) => Promise<void>;
}) {
  const contributions = companions.filter((companion) => companion.slot === slot);
  if (contributions.length === 0) return null;
  return (
    <section
      className="grid gap-1 px-1 pb-2"
      aria-label="Extension controls"
      data-extension-slot={slot}
    >
      {contributions.map((companion) => (
        <ExtensionCompanionContribution
          key={companion.id}
          companion={companion}
          onAction={(action, value) => onAction(companion.id, action, value)}
        />
      ))}
    </section>
  );
});
