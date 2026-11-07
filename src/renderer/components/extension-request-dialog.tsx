import { observer, useStore } from "r-state-tree/react";
import { DialogBackdrop } from "@/components/ui/dialog";
import { UiDialog } from "@/components/ui-dialog";
import { RootStore } from "../stores/RootStore";

export const ExtensionRequestDialog = observer(function ExtensionRequestDialog() {
  const root = useStore(RootStore);
  const extensionUi = root.extensionUiStore;
  if (!extensionUi.request) return null;
  return (
    <DialogBackdrop>
      <UiDialog
        key={extensionUi.request.uiRequestId}
        request={extensionUi.request}
        extensionUi={extensionUi}
        authNotice={root.settingsStore.providers.authNoticeForRequest(extensionUi.request)}
        openAuthUrl={(url) => void root.settingsStore.providers.openAuthUrl(url)}
      />
    </DialogBackdrop>
  );
});
