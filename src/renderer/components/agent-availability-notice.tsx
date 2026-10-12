import { observer, useStore } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { RootStore } from "../stores/RootStore";

export const AgentAvailabilityNotice = observer(function AgentAvailabilityNotice() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const projectOpen = store.projectOpenStore;
  if (store.agentAvailability !== "unavailable" || !projectOpen.projectPath) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-xl border border-border bg-card p-2.5 px-3 text-xs shadow-lg">
      <span>{store.agentAvailabilityReason ?? "The coding agent is unavailable."}</span>
      <Button size="sm" onClick={() => void store.restartPi()}>
        Restart and reopen
      </Button>
    </div>
  );
});
