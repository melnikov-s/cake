import { observer, useStore } from "r-state-tree/react";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { BackIcon, CloseIcon, TerminalIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";

export const AppSurfaceHeader = observer(function AppSurfaceHeader() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const projectOpen = store.projectOpenStore;
  const session = store.activeSession;
  const surface = root.appShellStore.surface;
  const applicationView = surface === "settings" || surface === "automations";
  const extensionUi = root.extensionUiStore;
  const terminal = root.terminalStore;
  const returnToWorkbench = () => root.navigationStore.returnToWorkbench();
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "relative box-content flex h-title-bar w-full max-w-full min-w-0 items-center justify-between overflow-hidden border-b border-border/65 px-5 [app-region:drag] max-[620px]:pl-[88px] phone:pl-[88px]",
        applicationView ? "pl-[100px]" : "pl-[46px] pr-12",
      )}
    >
      <div className="flex w-0 min-w-0 flex-1 items-center gap-3">
        {applicationView && (
          <IconButton
            className="grid size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]"
            tooltip="Back to chat"
            onClick={returnToWorkbench}
          >
            <BackIcon />
          </IconButton>
        )}
        {surface === "workbench" && session && (
          <Avatar
            kind="project"
            seed={projectOpen.projectName}
            customIcon={
              projectOpen.projectPath
                ? root.projectCatalogStore.find(projectOpen.projectPath)?.settings.icon
                : undefined
            }
            className="size-5"
            title={projectOpen.projectName}
            aria-hidden="true"
          />
        )}
        <strong className="block min-w-0 max-w-full truncate text-sm font-semibold">
          {surface === "automations"
            ? "Automations"
            : surface === "automation-session"
              ? (root.automationSessionsStore.selectedSession?.displayTitle ?? "Automation run")
              : surface === "settings"
                ? "Settings"
                : surface === "artifact-library"
                  ? "All artifacts"
                  : surface === "cake-chat"
                    ? "Cake Chat"
                    : (extensionUi.title ?? (session ? store.sessionTitle : "Cake"))}
        </strong>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 [app-region:no-drag]">
        {surface === "artifact-library" && (
          <IconButton tooltip="Close all artifacts" onClick={returnToWorkbench}>
            <CloseIcon />
          </IconButton>
        )}
        {terminal.available && surface !== "automations" && surface !== "automation-session" && (
          <IconButton
            data-cake-hint-key="t"
            className="phone:hidden"
            tooltip="Terminal"
            hotkey="toggle-terminal"
            aria-pressed={terminal.open}
            onClick={() => void terminal.toggle()}
          >
            <TerminalIcon />
          </IconButton>
        )}
      </div>
    </header>
  );
});
