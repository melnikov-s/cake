/** DOM event the overlay renderer dispatches each time main drops the overlay down. */
export const cakeChatOverlayShownEventName = "cake-chat-overlay-shown";

declare global {
  interface WindowEventMap {
    [cakeChatOverlayShownEventName]: Event;
  }
}
