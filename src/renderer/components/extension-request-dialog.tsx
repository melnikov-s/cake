import { observer, useStore } from "r-state-tree/react";
import { DialogBackdrop } from "@/components/ui/dialog";
import { UiDialog } from "@/components/ui-dialog";
import { RootStore } from "../stores/RootStore";

export const ExtensionRequestDialog = observer(function ExtensionRequestDialog() {
  const root = useStore(RootStore);
  const extensionUi = root.extensionUiStore;
  const request = extensionUi.request;
  if (!request) return null;
  return (
    <DialogBackdrop>
      <UiDialog
        key={`${request.sessionId}:${request.operationId}:${request.uiRequestId}`}
        request={request}
        extensionUi={extensionUi}
        authNotice={root.settingsStore.providers.authNoticeForRequest(request)}
        openAuthUrl={(url) => void root.settingsStore.providers.openAuthUrl(url)}
      />
    </DialogBackdrop>
  );
});
