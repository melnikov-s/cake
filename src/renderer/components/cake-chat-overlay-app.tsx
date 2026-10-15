import { useCallback, useEffect, useRef } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { useAppDocument } from "../hooks/use-app-document";
import { cakeChatOverlayShownEventName } from "../lib/cake-chat-overlay";
import { AppNotifications } from "./app-notifications";
import { AttachmentReferencePreview } from "./attachment-reference-preview";
import { CakeChatSurface } from "./cake-chat-surface";
import { MessageReferencePreview } from "./message-reference-preview";

/**
 * The drop-down window's whole UI: the shared Cake Chat surface with overlay chrome. It does not
 * own a conversation; the Root Store observes the same backend Cake Chat as every main window.
 */
export const CakeChatOverlayApp = observer(function CakeChatOverlayApp() {
  const root = useStore(RootStore);
  const panel = useRef<HTMLDivElement>(null);
  useAppDocument(root);
  const hide = useCallback(
    () =>
      void root.client.electron.hideCakeChatOverlay().catch((error: unknown) =>
        root.toastStore.show({
          tone: "error",
          title: "Could not close drop-down Cake Chat",
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    [root],
  );

  useEffect(() => {
    const focusComposer = () => {
      const selection = root.appShellStore.selection;
      const sessionId = selection.kind === "cake-chat" ? selection.sessionId : undefined;
      if (sessionId)
        root.cakeChatCollectionStore.registry
          .find(sessionId)
          ?.conversationSessionStore.composerStore.draftStore.requestFocus();
    };
    const shown = () => {
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        panel.current?.animate(
          [
            { transform: "translateY(-100%)", opacity: 0.6 },
            { transform: "translateY(0)", opacity: 1 },
          ],
          { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
      focusComposer();
    };
    const escape = (event: KeyboardEvent) => {
      // Components that use Escape themselves (stopping a response, closing a menu, preview, or
      // dialog) claim it first; only an unclaimed Escape puts the overlay away.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      hide();
    };
    window.addEventListener(cakeChatOverlayShownEventName, shown);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener(cakeChatOverlayShownEventName, shown);
      window.removeEventListener("keydown", escape);
    };
  }, [root, hide]);

  return (
    <div
      ref={panel}
      data-slot="cake-chat-overlay"
      className="flex h-screen min-h-0 flex-col overflow-hidden border-b border-border bg-background text-foreground"
    >
      <div className="min-h-0 flex-1">
        <CakeChatSurface overlay={{ onClose: hide }} />
      </div>
      <AppNotifications />
      <MessageReferencePreview store={root.navigationStore.messageReferencePreview} />
      <AttachmentReferencePreview store={root.navigationStore.attachmentReferencePreview} />
    </div>
  );
});
