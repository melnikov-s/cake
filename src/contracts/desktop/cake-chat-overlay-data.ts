import { Schema } from "effect";

/** Command+Backquote on macOS (Control+Backquote elsewhere), in Cake's hotkey notation. */
export const DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT = "Mod+`";

/** An empty shortcut turns the system-wide drop-down Cake Chat shortcut off. */
export const CakeChatOverlaySettings = Schema.Struct({
  shortcut: Schema.String.check(Schema.isMaxLength(128)),
  /** Whether the shortcut brings the frontmost app's selected text along (macOS only). */
  captureSelectedText: Schema.Boolean,
});
export interface CakeChatOverlaySettings extends Schema.Schema.Type<
  typeof CakeChatOverlaySettings
> {}

/** Query parameter that boots a renderer as the drop-down Cake Chat overlay. */
export const CAKE_CHAT_OVERLAY_QUERY = "cakeChatOverlay";

/** Upper bound for selected text carried into the overlay; the composer enforces its own limit. */
export const MAX_OVERLAY_SELECTED_TEXT_LENGTH = 1_000_000;

/** Text the user had selected in another app when the shortcut dropped the overlay down. */
export const OverlaySelectedText = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_OVERLAY_SELECTED_TEXT_LENGTH),
  ),
  application: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export interface OverlaySelectedText extends Schema.Schema.Type<typeof OverlaySelectedText> {}

/** Context that accompanies one drop-down: a selection, or why none could be read. */
export const CakeChatOverlayShownContext = Schema.Struct({
  selectedText: Schema.optionalKey(OverlaySelectedText),
  notice: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
});
export interface CakeChatOverlayShownContext extends Schema.Schema.Type<
  typeof CakeChatOverlayShownContext
> {}
