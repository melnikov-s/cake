import { toStoreEvent } from "../events/StoreEvent";
import { Effect } from "effect";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";
import { RenderedWidgetCaptureError } from "../../contracts/widgets/rendered-widget-capture-errors";
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
) =>
  runtime.observe(
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
        void runtime
          .execute(
            Effect.gen(function* () {
              const client = yield* CakeIpcClient;
              const result = yield* Effect.gen(function* () {
                if (host === "browser")
                  throw new Error("Native Browser Mode is unavailable in this browser");
                if (event.operation === "enter") {
                  yield* client.browser["native-browser-enter"]({
                    sessionId: event.sessionId,
                    workspacePath: event.workspacePath,
                  });
                  return { status: "completed" as const, value: null };
                }
                if (event.operation === "cdp") {
                  if (!event.method || !event.params) throw new Error("Incomplete CDP request");
                  return yield* client.browser["native-browser-cdp"]({
                    sessionId: event.sessionId,
                    method: event.method,
                    params: event.params,
                  });
                }
                return yield* client.browser["native-browser-events"]({
                  sessionId: event.sessionId,
                  methods: event.methods ?? [],
                  limit: event.limit ?? 100,
                  clear: event.clear ?? true,
                });
              }).pipe(
                Effect.catch((cause) =>
                  Effect.succeed({
                    status: "failed" as const,
                    message: (cause instanceof Error ? cause.message : String(cause)).slice(
                      0,
                      2_000,
                    ),
                  }),
                ),
              );
              yield* client.browser["respond-browser-native"]({
                requestId: event.requestId,
                sessionId: event.sessionId,
                result,
              });
            }),
          )
          .catch((error) => root.projectWorkbenchStore.setError(error, "Browser native response"));
        return;
      }
      if (event.type === "widget-capture-requested") {
        void runtime
          .execute(
            Effect.gen(function* () {
              const client = yield* CakeIpcClient;
              const result =
                host === "browser"
                  ? {
                      ok: false as const,
                      kind: "infrastructure" as const,
                      message: "Native widget capture is unavailable in this browser",
                    }
                  : yield* client.widgets["capture-native-widget"]({
                      sessionId: event.sessionId,
                      widget: event.widget,
                      pluginState: event.pluginState,
                    }).pipe(
                      Effect.map((value) => ({ ok: true as const, ...value })),
                      Effect.catch((cause) =>
                        Effect.succeed({
                          ok: false as const,
                          kind:
                            cause instanceof RenderedWidgetCaptureError
                              ? cause.kind
                              : ("infrastructure" as const),
                          message:
                            cause instanceof Error
                              ? cause.message.slice(0, 2000)
                              : "Desktop capture unavailable",
                        }),
                      ),
                    );
              yield* client.widgets["respond-widget-capture"]({
                requestId: event.requestId,
                sessionId: event.sessionId,
                result,
              });
            }),
          )
          .catch((error) => root.projectWorkbenchStore.setError(error, "Widget capture response"));
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
          root.sessionRegistry.findSession(storeEvent.record.sessionId)?.receive(storeEvent);
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
