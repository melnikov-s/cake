import { toStoreEvent } from "../events/StoreEvent";
import { discussionSessionFor } from "../lib/nested-transcript-behavior";
import { respondBrowserNative } from "./browser-native-responder";
import { respondWidgetCapture } from "./widget-capture-responder";
import { createNativeRequestDispatch } from "./native-request-dispatch";
import { cakeNativeHotkeyInputEventName } from "../lib/hotkeys";
import { cakeChatOverlayShownEventName } from "../lib/cake-chat-overlay";
import { receiveCakeChatOverlayContext } from "../bootstrap/start-cake-chat-overlay";
import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused application events to their Store owners. */
export const observeApplicationEvents = (
  runtime: Runtime,
  root: RootStore,
  host: "desktop" | "browser" = "desktop",
) => {
  const nativeRequests = createNativeRequestDispatch(runtime, (error, context) =>
    root.projectWorkbenchStore.setError(error, context),
  );
  const stop = runtime.observe(
    (client) => client.events.application(),
    (event) => {
      if (event.type === "screen-capture-requested") {
        if (host === "desktop") void root.screenCaptureStore.capture();
        return;
      }
      if (event.type === "cake-chat-overlay-shown") {
        window.dispatchEvent(new Event(cakeChatOverlayShownEventName));
        void receiveCakeChatOverlayContext(root, event).catch((error: unknown) =>
          root.toastStore.show({
            tone: "error",
            title: "Could not attach the selected text",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (event.type === "session-open-requested") {
        void root.navigationStore.openSessionLink(event.sessionId).catch((error: unknown) =>
          root.toastStore.show({
            tone: "error",
            title: "Could not open session",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (event.type === "window-blurred") {
        void root.conversationModeStore.exit();
        return;
      }
      if (event.type === "pi-settings-changed") {
        root.settingsStore.providers.piSettings = event.settings;
        return;
      }
      if (event.type === "agent-action-notice") {
        root.applicationControlStore.presentAgentAction(event);
        return;
      }
      if (event.type === "provider-auth-notice") {
        root.settingsStore.providers.receiveAuthNotice(event);
        if (
          event.sessionId &&
          (event.notice.type === "auth_url" || event.notice.type === "device_code")
        ) {
          root.toastStore.show({
            title: "Provider authentication",
            message: "Open Settings → Providers to continue authentication on this device.",
            coalesceKey: `provider-auth:${event.provider}`,
          });
        }
        return;
      }
      if (event.type === "browser-native-requested") {
        nativeRequests.dispatch(
          event.requestId,
          respondBrowserNative(event, host),
          "Browser native response",
        );
        return;
      }
      if (event.type === "widget-capture-requested") {
        nativeRequests.dispatch(
          event.requestId,
          respondWidgetCapture(event, host),
          "Widget capture response",
        );
        return;
      }
      if (event.type === "application-hotkey-input") {
        window.dispatchEvent(
          new CustomEvent(cakeNativeHotkeyInputEventName, { detail: event, cancelable: true }),
        );
        return;
      }
      const storeEvent = toStoreEvent(event);
      if (!storeEvent) return;
      try {
        if (storeEvent.type === "notification") {
          void root.notificationStore.enqueue({
            title: storeEvent.title,
            body: storeEvent.message,
            level: storeEvent.tone,
          });
          return;
        }
        if (storeEvent.type === "interview-requested") {
          const sessionId = storeEvent.record.sessionId;
          const owner =
            root.sessionRegistry.findSession(sessionId) ??
            discussionSessionFor(root, (session) => session.sessionId === sessionId);
          owner?.conversationSessionStore.receive(storeEvent);
          return;
        }
        if (storeEvent.type === "project-session-control-requested") {
          void root.applicationControlStore.handleProjectSessionRequest(storeEvent);
          return;
        }
        root.extensionUiStore.receive(storeEvent);
        root.projectWorkbenchStore.receive(storeEvent);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Application event: ${storeEvent.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Application event observation"),
    },
  );
  return () => {
    stop();
    nativeRequests.dispose();
  };
};
