import { observer, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { DialogBackdrop } from "@/components/ui/dialog";
import { RootStore } from "../stores/RootStore";

export const WorkspaceTrustDialog = observer(function WorkspaceTrustDialog() {
  const root = useStore(RootStore);
  const projectOpen = root.projectWorkbenchStore.projectOpenStore;
  if (!projectOpen.pendingTrustPath) return null;
  return (
    <DialogBackdrop>
      <Confirmation
        state="requested"
        role="alertdialog"
        aria-labelledby="trust-title"
        aria-describedby="trust-description"
      >
        <ConfirmationRequest>
          <ConfirmationTitle id="trust-title">Trust this workspace?</ConfirmationTitle>
          <ConfirmationDescription id="trust-description">
            {projectOpen.pendingTrustPath} contains project-local executable Pi resources. Trust it
            only if you know its contents.
          </ConfirmationDescription>
          <ConfirmationActions>
            <ConfirmationAction
              variant="outline"
              onClick={() => void projectOpen.resolveProjectTrust(false)}
            >
              Cancel
            </ConfirmationAction>
            <ConfirmationAction onClick={() => void projectOpen.resolveProjectTrust(true)}>
              Trust and open
            </ConfirmationAction>
          </ConfirmationActions>
        </ConfirmationRequest>
      </Confirmation>
    </DialogBackdrop>
  );
});
