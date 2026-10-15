import { execFile } from "node:child_process";
import { Schema } from "effect";
import {
  MAX_OVERLAY_SELECTED_TEXT_LENGTH,
  type OverlaySelectedText,
} from "../../contracts/desktop/cake-chat-overlay-data";

/**
 * JavaScript for Automation run by `osascript`. macOS attributes Accessibility to the
 * responsible app, so this child process uses Cake's own Accessibility grant and needs no
 * Apple Events (Automation) permission.
 *
 * 1. Ask the focused UI element of the frontmost app for `AXSelectedText`.
 * 2. When that is empty and the fallback is enabled, save every pasteboard item, post
 *    Command+C to the frontmost app, wait briefly for the pasteboard to change, read its
 *    string, and then restore the saved items exactly.
 */
export const SELECTED_TEXT_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
function readAccessibility() {
  const focused = Ref();
  if ($.AXUIElementCopyAttributeValue($.AXUIElementCreateSystemWide(), $("AXFocusedUIElement"), focused) !== 0)
    return "";
  const selected = Ref();
  if ($.AXUIElementCopyAttributeValue(focused[0], $("AXSelectedText"), selected) !== 0) return "";
  const value = ObjC.unwrap(ObjC.castRefToObject(selected[0]));
  return typeof value === "string" ? value : "";
}
function readByCopying() {
  const board = $.NSPasteboard.generalPasteboard;
  const saved = [];
  const items = board.pasteboardItems;
  const count = items.isNil() ? 0 : items.count;
  for (let index = 0; index < count; index += 1) {
    const item = items.objectAtIndex(index);
    const entries = [];
    for (let typeIndex = 0; typeIndex < item.types.count; typeIndex += 1) {
      const type = item.types.objectAtIndex(typeIndex);
      const data = item.dataForType(type);
      if (!data.isNil()) entries.push([type, data]);
    }
    saved.push(entries);
  }
  const before = Number(board.changeCount);
  const post = (down) => {
    const event = $.CGEventCreateKeyboardEvent(null, 8, down);
    $.CGEventSetFlags(event, $.kCGEventFlagMaskCommand);
    $.CGEventPost($.kCGHIDEventTap, event);
  };
  post(true);
  post(false);
  let changed = false;
  for (let attempt = 0; attempt < 25 && !changed; attempt += 1) {
    delay(0.012);
    changed = Number(board.changeCount) !== before;
  }
  if (!changed) return "";
  const copied = board.stringForType($.NSPasteboardTypeString);
  const text = copied.isNil() ? "" : ObjC.unwrap(copied);
  board.clearContents;
  const restored = $.NSMutableArray.array;
  for (const entries of saved) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entries) item.setDataForType(data, type);
    restored.addObject(item);
  }
  if (restored.count) board.writeObjects(restored);
  return text;
}
function run(argv) {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const application = app.isNil() || app.localizedName.isNil() ? "" : ObjC.unwrap(app.localizedName);
  let text = readAccessibility();
  let source = "accessibility";
  if (!text.trim() && argv[0] === "copy") {
    text = readByCopying();
    source = "clipboard";
  }
  return JSON.stringify({ text, application, source });
}
`;

export type SelectedTextResult =
  | { readonly kind: "text"; readonly selection: OverlaySelectedText }
  | { readonly kind: "none" }
  | { readonly kind: "permission-denied" }
  | { readonly kind: "failed"; readonly message: string };

export interface SelectedTextReaderOptions {
  readonly platform: NodeJS.Platform;
  /** Electron's `systemPreferences.isTrustedAccessibilityClient(false)`. */
  readonly accessibilityTrusted: () => boolean;
  /** Runs the script and resolves with its standard output. */
  readonly runScript: (script: string, args: readonly string[]) => Promise<string>;
  readonly clipboardFallback: boolean;
}

export const ACCESSIBILITY_PERMISSION_MESSAGE =
  "Cake can't read the selected text. Allow Cake in System Settings → Privacy & Security → Accessibility, then restart Cake. You can also turn this off in Settings → Cake Chat.";

export function runOsaScript(script: string, args: readonly string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...args],
      { timeout: 1_500, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const ScriptOutput = Schema.fromJsonString(
  Schema.Struct({ text: Schema.String, application: Schema.String }),
);
const decodeScriptOutput = Schema.decodeUnknownSync(ScriptOutput);

/** Reads the frontmost app's selection on macOS; never throws. */
export async function readSelectedText(
  options: SelectedTextReaderOptions,
): Promise<SelectedTextResult> {
  if (options.platform !== "darwin") return { kind: "none" };
  if (!options.accessibilityTrusted()) return { kind: "permission-denied" };
  try {
    const { text, application } = decodeScriptOutput(
      await options.runScript(SELECTED_TEXT_SCRIPT, options.clipboardFallback ? ["copy"] : []),
    );
    if (!text.trim()) return { kind: "none" };
    const selected = text.slice(0, MAX_OVERLAY_SELECTED_TEXT_LENGTH);
    return {
      kind: "text",
      selection: application
        ? { text: selected, application: application.slice(0, 256) }
        : { text: selected },
    };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
