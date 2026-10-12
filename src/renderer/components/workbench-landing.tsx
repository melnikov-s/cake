import { observer, useStore } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { ChatIcon, FolderIcon } from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { ErrorNotice } from "@/components/error-notice";
import { RootStore } from "../stores/RootStore";

export const WorkbenchLanding = observer(function WorkbenchLanding() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const projectOpen = store.projectOpenStore;
  const session = store.activeSession;
  const reviews = root.reviewsStore;
  const shell = root.appShellStore;
  const composer = session?.conversationSessionStore.composerStore;
  const chatConfiguration = session?.conversationSessionStore.configurationStore;
  const extensionUi = root.extensionUiStore;
  const interviewError = session?.interviewError;
  const selectedProjectSessionId =
    shell.selection.kind === "project-session" ? shell.selection.sessionId : undefined;
  const workbenchError =
    store.contextError(session?.sessionId ?? selectedProjectSessionId) ??
    (projectOpen.error
      ? { message: projectOpen.error, details: projectOpen.errorDetails }
      : undefined);
  const chatError =
    workbenchError?.message ??
    composer?.error ??
    reviews.error ??
    chatConfiguration?.error ??
    extensionUi.error ??
    interviewError?.error;
  const chatErrorDetails = workbenchError
    ? workbenchError.details
    : composer?.error
      ? composer.errorDetails
      : reviews.error
        ? reviews.errorDetails
        : chatConfiguration?.error
          ? chatConfiguration.errorDetails
          : extensionUi.error
            ? extensionUi.errorDetails
            : interviewError?.errorDetails;
  return selectedProjectSessionId ? (
    <div className="grid h-full min-h-0 min-w-0 place-items-center content-center overflow-y-auto p-10 text-center">
      {chatError ? (
        <ErrorNotice
          title="Could not open session"
          message={chatError}
          details={chatErrorDetails}
        />
      ) : (
        <LoadingState label="Opening session" />
      )}
    </div>
  ) : (
    <div className="grid h-full min-h-0 min-w-0 place-items-center content-center overflow-y-auto p-10 text-center">
      <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
        <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
          C
        </span>
      </span>
      <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight">
        What should we build?
      </h1>
      <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
        Open a project for durable workspace chats, or start a one-off chat from your home
        directory.
      </p>
      <div className="mt-6 flex gap-2.5">
        <Button
          size="lg"
          data-cake-hint-key="o"
          disabled={store.agentAvailability !== "available" || projectOpen.isBusy}
          onClick={() => void root.navigationStore.chooseProject()}
        >
          <FolderIcon /> Open project
        </Button>
        <Button
          size="lg"
          variant="outline"
          data-cake-hint-key="q"
          disabled={store.agentAvailability !== "available" || projectOpen.isBusy}
          onClick={() => void root.navigationStore.startOneOffChat()}
        >
          <ChatIcon /> One-off chat
        </Button>
      </div>
      {chatError && (
        <ErrorNotice title="Operation failed" message={chatError} details={chatErrorDetails} />
      )}
    </div>
  );
});
