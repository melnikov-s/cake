import { observer, useStore } from "r-state-tree/react";
import { DialogBackdrop } from "@/components/ui/dialog";
import { UiDialog } from "@/components/ui-dialog";
import { RootStore } from "../stores/RootStore";

export const ExtensionRequestDialog = observer(function ExtensionRequestDialog() {
  const root = useStore(RootStore);
  const extensionUi = root.extensionUiStore;
  if (!extensionUi.visibleRequest) return null;
  return (
    <DialogBackdrop
      onClose={
        extensionUi.visibleRequest.kind === "workflow-choice"
          ? () => void extensionUi.respond(undefined, true)
          : undefined
      }
    >
      <UiDialog
        key={extensionUi.visibleRequest.uiRequestId}
        request={extensionUi.visibleRequest}
        extensionUi={extensionUi}
        authNotice={root.settingsStore.providers.authNoticeForRequest(extensionUi.visibleRequest)}
        openAuthUrl={(url) => void root.settingsStore.providers.openAuthUrl(url)}
      />
    </DialogBackdrop>
  );
});
