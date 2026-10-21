import { useEffect } from "react";
import {
  cakeHotkeyEventName,
  cakeNativeHotkeyInputEventName,
  hotkeyFromKeyboardEvent,
} from "@/lib/hotkeys";
import type { CakeHotkeyActionId } from "../../contracts/application/cake-settings-data";
import type { RootStore } from "../stores/RootStore";
import type { FullscreenResponseSelection } from "./use-app-fullscreen-response";

export function useAppHotkeys(
  root: RootStore,
  onOpenResponse: (response: FullscreenResponseSelection) => void,
) {
  const settings = root.settingsStore;
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        root.navigationStore.dismissTopSecondarySurface();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [root]);

  useEffect(() => {
    const recordingHotkey = () =>
      Boolean(document.querySelector('[data-slot="hotkey-recorder"][data-recording="true"]'));
    const runAction = (action: CakeHotkeyActionId, target: EventTarget | null) => {
      if (action === "new-terminal-tab" && target instanceof Element && target.closest(".xterm"))
        return;
      if (action === "open-hovered-message") {
        if (document.querySelector('[data-slot="message"]:hover')) {
          window.dispatchEvent(new CustomEvent(cakeHotkeyEventName, { detail: action }));
          return;
        }
        const current =
          root.appShellStore.surface === "workbench"
            ? root.projectWorkbenchStore.activeSession
            : root.appShellStore.surface === "cake-chat" &&
                root.appShellStore.selection.kind === "cake-chat" &&
                root.appShellStore.selection.sessionId
              ? root.cakeChatCollectionStore.registry.find(root.appShellStore.selection.sessionId)
              : undefined;
        const part = current?.conversationSessionStore.chatStore.parts.findLast(
          (part) => part.kind === "text" && part.role === "assistant" && Boolean(part.text),
        );
        if (current && part?.kind === "text")
          onOpenResponse({
            sessionId: current.sessionId,
            partId: part.id,
            renderKey: part.renderKey,
          });
      } else root.commands.execute(action);
    };
    const runHotkey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        recordingHotkey() ||
        (target instanceof Element && target.closest('[data-slot="hotkey-recorder"]'))
      )
        return;
      const action = settings.hotkeys.actionForEvent(event);
      if (!action) return;
      event.preventDefault();
      runAction(action, target);
    };
    const runNativeHotkey = (event: WindowEventMap["cake-native-hotkey-input"]) => {
      if (event.defaultPrevented || recordingHotkey()) return;
      const binding = hotkeyFromKeyboardEvent(event.detail);
      const action = binding ? settings.hotkeys.actionForBinding(binding) : undefined;
      if (!action) return;
      event.preventDefault();
      runAction(action, null);
    };
    window.addEventListener("keydown", runHotkey, { capture: true });
    window.addEventListener(cakeNativeHotkeyInputEventName, runNativeHotkey);
    return () => {
      window.removeEventListener("keydown", runHotkey, { capture: true });
      window.removeEventListener(cakeNativeHotkeyInputEventName, runNativeHotkey);
    };
  }, [root, settings.hotkeys, onOpenResponse]);
}
