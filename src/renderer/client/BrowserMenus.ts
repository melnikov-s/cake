import type { Client } from "./Client";
import type { BrowserMenuStore, BrowserMenuItem } from "../stores/BrowserMenuStore";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // LAN HTTP is not a secure context, so navigator.clipboard may be unavailable.
  // Run the legacy selection command synchronously in the menu click's user gesture.
  const selected = window.getSelection();
  const ranges = selected
    ? Array.from({ length: selected.rangeCount }, (_, index) => selected.getRangeAt(index))
    : [];
  const source = document.createElement("span");
  source.className = "fixed left-0 top-0 whitespace-pre opacity-0 pointer-events-none";
  source.textContent = text;
  document.body.append(source);
  try {
    const range = document.createRange();
    range.selectNodeContents(source);
    selected?.removeAllRanges();
    selected?.addRange(range);
    if (!document.execCommand("copy"))
      throw new Error("The browser could not copy to the clipboard");
  } finally {
    selected?.removeAllRanges();
    for (const range of ranges) selected?.addRange(range);
    source.remove();
  }
}

export function browserMenus(
  store: BrowserMenuStore,
): Pick<
  Client["electron"],
  | "showTranscriptSelectionContextMenu"
  | "showComposerContextMenu"
  | "showSessionContextMenu"
  | "showProjectContextMenu"
> {
  const copy = (label: string, text: string): BrowserMenuItem => ({
    label,
    run: () => copyText(text),
  });
  return {
    showTranscriptSelectionContextMenu: async (input) => {
      const selection = window.getSelection()?.toString() ?? "";
      const action = await store.show("Selected text", [
        copy("Copy", selection),
        ...(input.canAnnotate ? [{ label: "Add annotation", action: "add-annotation" }] : []),
        ...(input.canChat ? [{ label: "Chat about this", action: "chat-about-selection" }] : []),
        {
          label: "Select all",
          run: () => {
            document.execCommand("selectAll");
          },
        },
      ]);
      return action === "add-annotation" || action === "chat-about-selection" ? action : undefined;
    },
    showComposerContextMenu: async (input) => {
      const target = document.activeElement;
      const composer = target instanceof HTMLTextAreaElement ? target : undefined;
      const replace = (text: string) => {
        if (!composer) return;
        const start = composer.selectionStart;
        const end = composer.selectionEnd;
        const value = composer.value.slice(0, start) + text + composer.value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(composer, value);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.focus();
        composer.setSelectionRange(start + text.length, start + text.length);
      };
      const action = await store.show("Composer", [
        copy("Copy", input.selection),
        {
          label: "Cut",
          disabled: !composer || !navigator.clipboard?.writeText,
          run: async () => {
            await navigator.clipboard.writeText(input.selection);
            replace("");
          },
        },
        {
          label: "Paste",
          disabled: !composer || !navigator.clipboard?.readText,
          run: async () => replace(await navigator.clipboard.readText()),
        },
        { label: "Reword", action: "reword" },
        { label: "Reword with Prompt…", action: "reword-with-prompt" },
        {
          label: "Select all",
          run: () => {
            composer?.focus();
            composer?.select();
          },
        },
      ]);
      return action === "reword" || action === "reword-with-prompt" ? action : undefined;
    },
    showSessionContextMenu: async (input) => {
      const copyId = copy("Copy Session ID", input.sessionId);
      const items: BrowserMenuItem[] = input.resolved
        ? [
            { label: "Unresolve", action: "unresolve" },
            copyId,
            ...(!input.familyChild ? [{ label: "Delete", action: "delete" }] : []),
          ]
        : [
            { label: "Rename", action: "rename" },
            ...(input.unread === false ? [{ label: "Mark as Unread", action: "mark-unread" }] : []),
            copyId,
            ...(!input.draft ? [{ label: "Resolve", action: "resolve" }] : []),
          ];
      const action = await store.show("Session actions", items);
      return action === "rename" ||
        action === "mark-unread" ||
        action === "resolve" ||
        action === "unresolve" ||
        action === "delete"
        ? { action }
        : undefined;
    },
    showProjectContextMenu: async (input) => {
      const action = await store.show("Project actions", [
        { label: "Project Settings…", action: "settings" },
        {
          label: `Sort Sessions: By Date${input.sessionSort === "date" ? " ✓" : ""}`,
          action: "sort-by-date",
        },
        {
          label: `Sort Sessions: By Label${input.sessionSort === "label" ? " ✓" : ""}`,
          action: "sort-by-label",
        },
        copy("Copy Project Path", input.path),
        {
          label: `Delete Resolved Worktrees (${input.resolvedWorktreeCount})`,
          action: "delete-resolved-worktrees",
          disabled: !input.resolvedWorktreeCount,
        },
        { label: "Remove Project…", action: "remove-project" },
      ]);
      return action === "settings" ||
        action === "sort-by-date" ||
        action === "sort-by-label" ||
        action === "delete-resolved-worktrees" ||
        action === "remove-project"
        ? action
        : undefined;
    },
  };
}
