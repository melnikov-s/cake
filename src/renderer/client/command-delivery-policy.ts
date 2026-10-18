/** Whether a lost receipt needs user review before another mutation. This is NOT
 * a replay policy: no command, including these safe operations, is retried here. */
export function requiresDeliveryReview(operation: string): boolean {
  if (
    /\.(get|list|read|inspect|catalog|effective|detail|history|compare|reference|load|suggest)/i.test(
      operation,
    ) ||
    /\.(abort|cancel)/i.test(operation)
  )
    return false;
  switch (operation) {
    case "backendConnection.connect":
    case "projectSessions.open":
    case "projectSessions.lookup":
    case "cakeChats.open":
    case "modelPresets.resolve":
    case "piSettings.extensions":
    case "models.refresh":
    case "workflows.saved":
    case "artifacts.stateRead":
    case "artifacts.boardEntries":
    case "artifacts.boardBody":
    case "artifacts.boardReceipts":
    case "terminals.get-terminal-status":
    case "workspaces.post-process-dictation":
      return false;
    // Disposable presentation resources and advisory read/composing markers have
    // no uncertain user action to approve. Their owners refresh from authority or
    // reacquire resources; a lost receipt must not lock all conversation controls.
    case "widgets.compile-inline-widget":
    case "widgets.open-widget-browser":
    case "widgets.release":
    case "vscode.release":
    case "vscode.set-theme":
    case "workspaces.set-session-unread":
    case "cakeChats.setUnread":
    case "cakeChats.setComposing":
      return false;
    default:
      return true;
  }
}

/** Old false-positive read/resource receipts must not survive as a tab-wide lock. */
export function retainedDeliveryUncertainty(operation: string | null): string | undefined {
  return operation && requiresDeliveryReview(operation) ? operation : undefined;
}
