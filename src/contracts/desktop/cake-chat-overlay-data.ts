import { Schema } from "effect";

/** Command+Backquote on macOS (Control+Backquote elsewhere), in Cake's hotkey notation. */
export const DEFAULT_CAKE_CHAT_OVERLAY_SHORTCUT = "Mod+`";

/** An empty shortcut turns the system-wide drop-down Cake Chat shortcut off. */
export const CakeChatOverlaySettings = Schema.Struct({
  shortcut: Schema.String.check(Schema.isMaxLength(128)),
});
export interface CakeChatOverlaySettings extends Schema.Schema.Type<
  typeof CakeChatOverlaySettings
> {}

/** Query parameter that boots a renderer as the drop-down Cake Chat overlay. */
export const CAKE_CHAT_OVERLAY_QUERY = "cakeChatOverlay";
