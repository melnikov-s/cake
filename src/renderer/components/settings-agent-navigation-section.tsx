import { observer } from "r-state-tree/react";
import type { AgentNavigationSettingsStore } from "../stores/AgentNavigationSettingsStore";
import { SettingsToggle } from "./settings/settings-toggle";

export const SettingsAgentNavigationSection = observer(function SettingsAgentNavigationSection({
  navigation,
}: {
  navigation: AgentNavigationSettingsStore;
}) {
  return (
    <section className="grid gap-1.5" aria-labelledby="agent-navigation-title">
      <h2 id="agent-navigation-title" className="px-0.5 text-xs font-semibold text-foreground">
        Cake navigation
      </h2>
      <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card/50">
        <SettingsToggle
          id="setting-agent-session-navigation"
          label="Allow agent session navigation"
          description="Let agents open existing Project Sessions in this window."
          checked={navigation.enabled}
          onChange={(enabled) => navigation.setEnabled(enabled)}
        />
      </div>
    </section>
  );
});
