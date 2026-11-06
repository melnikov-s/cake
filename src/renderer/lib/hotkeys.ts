import type { CakeHotkeyActionId } from "../../contracts/application/cake-settings-data";
import { isMacPlatform } from "./platform";

export interface HotkeyDefinition {
  readonly id: CakeHotkeyActionId;
  readonly group: "Editor & tools" | "Navigation" | "Conversation";
  readonly label: string;
  readonly description: string;
  readonly defaultBinding: string;
}

export const hotkeyDefinitions: readonly HotkeyDefinition[] = [
  {
    id: "new-session",
    group: "Navigation",
    label: "New session",
    description: "Choose Cake Chat or a Project for a new session.",
    defaultBinding: "Mod+N",
  },
  {
    id: "toggle-agent-editor",
    group: "Editor & tools",
    label: "Toggle Agent / VS Code",
    description: "Switch between the conversation and embedded editor.",
    defaultBinding: "Mod+Shift+A",
  },
  {
    id: "open-editor",
    group: "Editor & tools",
    label: "Toggle VS Code",
    description: "Show or hide VS Code for the focused Project Session.",
    defaultBinding: "Mod+Shift+V",
  },
  {
    id: "open-changes",
    group: "Editor & tools",
    label: "Toggle Changes",
    description: "Show or hide Source Control for the focused Project Session.",
    defaultBinding: "Mod+Shift+G",
  },
  {
    id: "toggle-browser",
    group: "Editor & tools",
    label: "Toggle Browser Mode",
    description: "Show or hide Browser Mode for the focused Project Session.",
    defaultBinding: "Mod+Shift+B",
  },
  {
    id: "toggle-terminal",
    group: "Editor & tools",
    label: "Toggle terminal",
    description: "Show or hide the terminal for the focused Working Directory.",
    defaultBinding: "Mod+J",
  },
  {
    id: "new-terminal-tab",
    group: "Editor & tools",
    label: "New terminal tab",
    description: "Open another terminal tab for the focused Working Directory.",
    defaultBinding: "Mod+T",
  },
  {
    id: "toggle-sidebar",
    group: "Editor & tools",
    label: "Toggle Workspace",
    description: "Show or hide the To-dos and Sessions workspace.",
    defaultBinding: "Mod+B",
  },
  {
    id: "toggle-session-tree",
    group: "Editor & tools",
    label: "Toggle session tree",
    description: "Show or hide the focused session's tree.",
    defaultBinding: "Mod+Shift+E",
  },
  {
    id: "return-to-project-chat",
    group: "Navigation",
    label: "Return to Project Chat",
    description: "Open the focused conversation's Project Chat home.",
    defaultBinding: "Mod+Shift+H",
  },
  {
    id: "history-back",
    group: "Navigation",
    label: "Go back",
    description: "Go to the previous session in conversation history.",
    defaultBinding: isMacPlatform ? "Mod+[" : "Alt+ArrowLeft",
  },
  {
    id: "history-forward",
    group: "Navigation",
    label: "Go forward",
    description: "Go to the next session in conversation history.",
    defaultBinding: isMacPlatform ? "Mod+]" : "Alt+ArrowRight",
  },
  {
    id: "next-active-session",
    group: "Navigation",
    label: "Next active session",
    description:
      "Cycle forward through running or waiting sessions in sidebar order, wrapping around.",
    defaultBinding: isMacPlatform ? "Mod+Shift+]" : "Alt+Shift+ArrowRight",
  },
  {
    id: "previous-active-session",
    group: "Navigation",
    label: "Previous active session",
    description:
      "Cycle backward through running or waiting sessions in sidebar order, wrapping around.",
    defaultBinding: isMacPlatform ? "Mod+Shift+[" : "Alt+Shift+ArrowLeft",
  },
  {
    id: "open-settings",
    group: "Navigation",
    label: "Toggle Settings",
    description: "Show or hide Cake settings.",
    defaultBinding: "Mod+,",
  },
  {
    id: "show-ui-hints",
    group: "Navigation",
    label: "Show UI hints",
    description: "Label visible controls for keyboard activation.",
    defaultBinding: "Mod+G",
  },
  {
    id: "toggle-dictation-mute",
    group: "Conversation",
    label: "Toggle dictation mute",
    description: "Mute or unmute dictation without changing its enabled setting.",
    defaultBinding: "",
  },
  {
    id: "open-companion",
    group: "Conversation",
    label: "Open companion",
    description: "Open the shared companion popup or focus its input when already open.",
    defaultBinding: "Mod+Shift+J",
  },
  {
    id: "toggle-work-logs",
    group: "Conversation",
    label: "Change work-log expansion",
    description: "Cycle collapsed, expanded, and fully expanded work logs.",
    defaultBinding: isMacPlatform ? "Ctrl+O" : "Mod+O",
  },
  {
    id: "cycle-work-log-view",
    group: "Conversation",
    label: "Change work-log view",
    description: "Cycle automatic, diff, and log work-log views.",
    defaultBinding: isMacPlatform ? "Ctrl+Shift+O" : "Mod+Shift+O",
  },
  {
    id: "open-hovered-message",
    group: "Conversation",
    label: "Open message fullscreen",
    description:
      "Open the hovered response, or the current session's latest response when no message is hovered.",
    defaultBinding: isMacPlatform ? "Mod+Enter" : "Alt+Enter",
  },
];

export const cakeHotkeyEventName = "cake-hotkey";
export const cakeNativeHotkeyInputEventName = "cake-native-hotkey-input";

export interface HotkeyInput {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly modifierTap?: "AltLeft" | "AltRight";
}

declare global {
  interface WindowEventMap {
    "cake-native-hotkey-input": CustomEvent<HotkeyInput>;
  }
}

const definitionById = new Map(hotkeyDefinitions.map((definition) => [definition.id, definition]));

export function defaultHotkeyBinding(id: CakeHotkeyActionId) {
  return definitionById.get(id)?.defaultBinding ?? "";
}

export function hotkeyFromKeyboardEvent(event: HotkeyInput): string | undefined {
  if (event.isComposing || event.repeat) return undefined;
  if (event.modifierTap) return event.modifierTap;
  const modifiers = [
    (isMacPlatform ? event.metaKey : event.ctrlKey) ? "Mod" : undefined,
    (isMacPlatform ? event.ctrlKey : false) ? "Ctrl" : undefined,
    event.altKey ? "Alt" : undefined,
    event.shiftKey ? "Shift" : undefined,
  ].filter((value): value is string => Boolean(value));
  const modifierKeys = new Set(["Meta", "Control", "Alt", "Shift"]);
  if (modifierKeys.has(event.key)) return undefined;
  const physicalKey =
    event.code === "Backquote"
      ? "`"
      : event.code === "Backslash"
        ? "\\"
        : event.code === "BracketLeft"
          ? "["
          : event.code === "BracketRight"
            ? "]"
            : event.code === "Comma"
              ? ","
              : undefined;
  let key =
    physicalKey ??
    (event.code.startsWith("Key") || event.code.startsWith("Digit")
      ? event.code.replace(/^(?:Key|Digit)/, "")
      : event.key);
  if (key === " ") key = "Space";
  else if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
  if (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) return undefined;
  return [...modifiers, key].join("+");
}

export function formatHotkey(binding: string) {
  if (!binding) return "Not assigned";
  if (binding === "AltRight") return isMacPlatform ? "Right Option" : "Right Alt";
  if (binding === "AltLeft") return isMacPlatform ? "Left Option" : "Left Alt";
  if (!isMacPlatform) return binding.replace("Mod+", "Ctrl+");
  return binding
    .replace("Mod+", "⌘")
    .replace("Ctrl+", "⌃")
    .replaceAll("Alt+", "⌥")
    .replaceAll("Shift+", "⇧")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓");
}
