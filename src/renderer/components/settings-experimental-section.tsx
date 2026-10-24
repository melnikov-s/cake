import { observer } from "r-state-tree/react";
import { SettingsToggle } from "./settings/settings-toggle";
import type { ExperimentalSettingsStore } from "../stores/ExperimentalSettingsStore";

export const SettingsExperimentalSection = observer(function SettingsExperimentalSection({
  experimental,
}: {
  experimental: ExperimentalSettingsStore;
}) {
  return (
    <section aria-labelledby="experimental-title" className="grid gap-1.5">
      <h2 id="experimental-title" className="px-0.5 text-xs font-semibold text-foreground">
        Experimental features
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <SettingsToggle
          id="setting-dynamic-workflows"
          label="Dynamic workflows"
          description="Let agents offer script-driven background workflows with a Run workflow / Continue normally choice."
          checked={experimental.dynamicWorkflows}
          disabled={experimental.saving}
          onChange={(enabled) => void experimental.setDynamicWorkflows(enabled)}
        />
      </div>
      <p className="px-0.5 text-xs text-muted-foreground">
        Disabling prevents new workflow proposals; running workflows keep their progress and
        controls.
      </p>
    </section>
  );
});
