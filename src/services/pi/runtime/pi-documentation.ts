/** Cake omits terminal-only references from Pi's generated documentation guidance. */
export function withoutTerminalDocumentation(docs: string): string {
  return docs
    .replace(", themes, skills, or TUI", ", or skills")
    .replace(", themes (docs/themes.md)", "")
    .replace(", TUI components (docs/tui.md)", "")
    .replace(", keybindings (docs/keybindings.md)", "")
    .replace(" (e.g., tui.md for TUI API details)", "");
}
