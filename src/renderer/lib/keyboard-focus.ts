export const keyboardPopupSelector =
  'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]';

export function isVisibleForKeyboard(element: HTMLElement) {
  return (
    element.isConnected &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible"
  );
}
