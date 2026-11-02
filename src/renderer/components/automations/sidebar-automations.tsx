import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { NavItem } from "../ui/nav-item";
import { RepeatIcon } from "../ui/icons";
import { AutomationSessionItems } from "./automation-session-items";

export const SidebarAutomations = observer(function SidebarAutomations() {
  const root = useStore(RootStore);
  return (
    <div className="mb-2" data-slot="sidebar-automations">
      <NavItem
        icon={<RepeatIcon />}
        label="Automations"
        badge={root.automationsStore.activeSessionCount || undefined}
        active={root.appShellStore.selection.kind === "automations"}
        onClick={() => root.navigationStore.showAutomations()}
      />
      <AutomationSessionItems />
    </div>
  );
});
