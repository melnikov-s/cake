export const MIN_WORKSPACE_PANEL_WIDTH = 240;
const MIN_MAIN_CHAT_WIDTH = 360;

/** Only Main reserves readable chat space; tool modes may prioritize the companion. */
export function mainWorkspacePanelMaxWidth(availableWidth: number) {
  return Math.max(0, availableWidth - MIN_MAIN_CHAT_WIDTH);
}
