import { observer, useStore } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ToastHost } from "@/components/toast-host";
import { RootStore } from "../stores/RootStore";

export const AppNotifications = observer(function AppNotifications() {
  const root = useStore(RootStore);
  const extensionUi = root.extensionUiStore;
  return (
    <ToastHost store={root.toastStore}>
      {extensionUi.notifications.map((notification) => (
        <Button
          variant="ghost"
          key={notification.id}
          type="button"
          className="block h-auto w-full whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent"
          onClick={() => extensionUi.dismissNotification(notification.id)}
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
            <span className="text-[11px] text-muted-foreground">{notification.message}</span>
          </Callout>
        </Button>
      ))}
    </ToastHost>
  );
});
