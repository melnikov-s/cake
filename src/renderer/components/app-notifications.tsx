import { observer, useStore } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ToastHost } from "@/components/toast-host";
import { useToastInteraction } from "../hooks/use-toast-interaction";
import type { ExtensionNotification, ExtensionUiStore } from "../stores/ExtensionUiStore";
import { RootStore } from "../stores/RootStore";

function ExtensionNotice({
  notification,
  store,
}: {
  notification: ExtensionNotification;
  store: ExtensionUiStore;
}) {
  const interaction = useToastInteraction(store, notification.id);
  return (
    <Button
      {...interaction}
      variant="ghost"
      type="button"
      className="block h-auto w-full whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent"
      onClick={() => store.dismissNotification(notification.id)}
    >
      <Callout
        variant={
          notification.tone === "error"
            ? "error"
            : notification.tone === "warning"
              ? "warning"
              : "default"
        }
        className="bg-popover text-popover-foreground shadow-md motion-safe:animate-toast-enter"
      >
        <strong className="text-xs">Extension</strong>
        <span className="text-xs text-muted-foreground">{notification.message}</span>
      </Callout>
    </Button>
  );
}

export const AppNotifications = observer(function AppNotifications() {
  const root = useStore(RootStore);
  const extensionUi = root.extensionUiStore;
  return (
    <ToastHost store={root.toastStore}>
      {extensionUi.notifications.map((notification) => (
        <ExtensionNotice key={notification.id} notification={notification} store={extensionUi} />
      ))}
    </ToastHost>
  );
});
