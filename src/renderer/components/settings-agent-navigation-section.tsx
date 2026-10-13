import { observer } from "r-state-tree/react";
import type { AgentNavigationSettingsStore } from "../stores/AgentNavigationSettingsStore";
import { Badge } from "./ui/badge";
import { SettingsToggle } from "./settings/settings-toggle";

export const SettingsAgentNavigationSection = observer(function SettingsAgentNavigationSection({
  navigation,
}: {
  navigation: AgentNavigationSettingsStore;
}) {
  return (
    <section className="border-t border-border py-5" aria-labelledby="agent-navigation-title">
      <header className="mb-4 flex items-start justify-between gap-4">
        <h2 id="agent-navigation-title" className="text-[15px] font-semibold text-foreground">
          Cake navigation
        </h2>
        <Badge variant="outline" size="xs" className="text-muted-foreground">
          This window
        </Badge>
      </header>
      <SettingsToggle
        id="setting-agent-session-navigation"
        label="Allow agent session navigation"
        description="Let agents open existing Project Sessions in this window. On by default; saved across restarts. Turning this off does not affect your own navigation or session links. Only you can change this permission."
        checked={navigation.enabled}
        onChange={(enabled) => navigation.setEnabled(enabled)}
      />
    </section>
  );
});
