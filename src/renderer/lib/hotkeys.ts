import { isMacPlatform } from "./platform";

export const hotkeyActionIds = [
  "toggle-agent-editor",
  "open-editor",
  "open-changes",
  "toggle-terminal",
  "new-terminal-tab",
  "toggle-sidebar",
  "toggle-session-tree",
  "split-right",
  "split-down",
  "focus-left",
  "focus-right",
  "focus-above",
  "focus-below",
  "focus-pane-1",
  "focus-pane-2",
  "focus-pane-3",
  "focus-pane-4",
  "history-back",
  "history-forward",
  "show-ui-hints",
  "toggle-work-logs",
  "cycle-work-log-view",
  "open-hovered-message",
  "open-settings",
] as const;

export type HotkeyActionId = (typeof hotkeyActionIds)[number];

export interface HotkeyDefinition {
  readonly id: HotkeyActionId;
  readonly group: "Editor & tools" | "Panes" | "Navigation" | "Conversation";
  readonly label: string;
  readonly description: string;
  readonly defaultBinding: string;
}

export const hotkeyDefinitions: readonly HotkeyDefinition[] = [
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
    label: "Open VS Code",
    description: "Open the focused Project Session in VS Code.",
    defaultBinding: "Mod+Shift+V",
  },
  {
    id: "open-changes",
    group: "Editor & tools",
    label: "Open Changes",
    description: "Open Source Control for the focused Project Session.",
    defaultBinding: "Mod+Shift+G",
  },
  {
    id: "toggle-terminal",
    group: "Editor & tools",
    label: "Toggle terminal",
    description: "Show or hide the terminal for the focused Working Directory.",
    defaultBinding: "Mod+`",
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
    label: "Toggle sidebar",
    description: "Show or hide Cake's project sidebar.",
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
    id: "split-right",
    group: "Panes",
    label: "Split pane right",
    description: "Create a side-by-side conversation pane.",
    defaultBinding: "Mod+\\",
  },
  {
    id: "split-down",
    group: "Panes",
    label: "Split pane down",
    description: "Create a stacked conversation pane.",
    defaultBinding: "Mod+Shift+\\",
  },
  {
    id: "focus-left",
    group: "Panes",
    label: "Focus pane left",
    description: "Move focus to the pane on the left.",
    defaultBinding: "Mod+Alt+ArrowLeft",
  },
  {
    id: "focus-right",
    group: "Panes",
    label: "Focus pane right",
    description: "Move focus to the pane on the right.",
    defaultBinding: "Mod+Alt+ArrowRight",
  },
  {
    id: "focus-above",
    group: "Panes",
    label: "Focus pane above",
    description: "Move focus to the pane above.",
    defaultBinding: "Mod+Alt+ArrowUp",
  },
  {
    id: "focus-below",
    group: "Panes",
    label: "Focus pane below",
    description: "Move focus to the pane below.",
    defaultBinding: "Mod+Alt+ArrowDown",
  },
  {
    id: "focus-pane-1",
    group: "Panes",
    label: "Focus pane 1",
    description: "Focus the first visible conversation pane.",
    defaultBinding: "Mod+1",
  },
  {
    id: "focus-pane-2",
    group: "Panes",
    label: "Focus pane 2",
    description: "Focus the second visible conversation pane.",
    defaultBinding: "Mod+2",
  },
  {
    id: "focus-pane-3",
    group: "Panes",
    label: "Focus pane 3",
    description: "Focus the third visible conversation pane.",
    defaultBinding: "Mod+3",
  },
  {
    id: "focus-pane-4",
    group: "Panes",
    label: "Focus pane 4",
    description: "Focus the fourth visible conversation pane.",
    defaultBinding: "Mod+4",
  },
  {
    id: "history-back",
    group: "Navigation",
    label: "Go back",
    description: "Go to the previous session in pane or application history.",
    defaultBinding: isMacPlatform ? "Mod+[" : "Alt+ArrowLeft",
  },
  {
    id: "history-forward",
    group: "Navigation",
    label: "Go forward",
    description: "Go to the next session in pane or application history.",
    defaultBinding: isMacPlatform ? "Mod+]" : "Alt+ArrowRight",
  },
  {
    id: "open-settings",
    group: "Navigation",
    label: "Open Settings",
    description: "Open Cake settings.",
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
    label: "Open hovered message",
    description: "Open the message currently under the pointer in a focused view.",
    defaultBinding: isMacPlatform ? "Mod+Enter" : "Alt+Enter",
  },
];

export const cakeHotkeyEventName = "cake-hotkey";

const definitionById = new Map(hotkeyDefinitions.map((definition) => [definition.id, definition]));

export function defaultHotkeyBinding(id: HotkeyActionId) {
  return definitionById.get(id)?.defaultBinding ?? "";
}

export function hotkeyFromKeyboardEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.repeat) return undefined;
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
