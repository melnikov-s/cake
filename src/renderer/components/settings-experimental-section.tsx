import { observer } from "r-state-tree/react";
import { SettingsToggle } from "./settings/settings-toggle";
import { Callout } from "./ui/callout";
import type { ExperimentalSettingsStore } from "../stores/ExperimentalSettingsStore";

export const SettingsExperimentalSection = observer(function SettingsExperimentalSection({
  experimental,
}: {
  experimental: ExperimentalSettingsStore;
}) {
  return (
    <section aria-labelledby="experimental-title" className="border-t border-border py-5">
      <h3 id="experimental-title" className="mb-4 text-[15px] font-semibold text-foreground">
        Experimental features
      </h3>
      <SettingsToggle
        id="setting-dynamic-workflows"
        label="Dynamic workflows"
        description="Let agents offer script-driven background workflows with a Run workflow / Continue normally choice. Off by default."
        checked={experimental.dynamicWorkflows}
        disabled={experimental.saving}
        onChange={(enabled) => void experimental.setDynamicWorkflows(enabled)}
      />
      <Callout className="mt-4">
        These features are still evolving. Disabling dynamic workflows prevents new proposals and
        runs, and cancels pending execution choices. Previously started runs retain their progress
        and controls; disabling does not stop them or undo edits.
      </Callout>
    </section>
  );
});
