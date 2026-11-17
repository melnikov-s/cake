import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  readSelectedText,
  SELECTED_TEXT_SCRIPT,
  type SelectedTextReaderOptions,
} from "../../../../src/services/electron/selected-text";

function reader(overrides: Partial<SelectedTextReaderOptions> = {}) {
  const runScript = vi.fn<SelectedTextReaderOptions["runScript"]>(async () =>
    JSON.stringify({ text: "Selected words", application: "Safari", source: "accessibility" }),
  );
  const options: SelectedTextReaderOptions = {
    platform: "darwin",
    accessibilityTrusted: () => true,
    runScript,
    clipboardFallback: true,
    ...overrides,
  };
  return { options, runScript };
}

describe("Selected text capture", () => {
  it("reads the frontmost selection and asks the script to fall back to copying", async () => {
    const { options, runScript } = reader();
    await expect(readSelectedText(options)).resolves.toEqual({
      kind: "text",
      selection: { text: "Selected words", application: "Safari" },
    });
    expect(runScript).toHaveBeenCalledWith(SELECTED_TEXT_SCRIPT, ["copy"]);
    const { options: accessibilityOnly, runScript: run } = reader({ clipboardFallback: false });
    await readSelectedText(accessibilityOnly);
    expect(run).toHaveBeenCalledWith(SELECTED_TEXT_SCRIPT, []);
  });

  it("reports missing Accessibility permission without running the script", async () => {
    const { options, runScript } = reader({ accessibilityTrusted: () => false });
    await expect(readSelectedText(options)).resolves.toEqual({ kind: "permission-denied" });
    expect(runScript).not.toHaveBeenCalled();
  });

  it("treats whitespace, other platforms, and script failures as no selection", async () => {
    const blank = reader({
      runScript: async () => JSON.stringify({ text: " \n", application: "" }),
    });
    await expect(readSelectedText(blank.options)).resolves.toEqual({ kind: "none" });
    const linux = reader({ platform: "linux" });
    await expect(readSelectedText(linux.options)).resolves.toEqual({ kind: "none" });
    expect(linux.runScript).not.toHaveBeenCalled();
    const failing = reader({
      runScript: async () => {
        throw new Error("Command failed: osascript timed out");
      },
    });
    await expect(readSelectedText(failing.options)).resolves.toEqual({
      kind: "failed",
      message: "Command failed: osascript timed out",
    });
    const garbled = reader({ runScript: async () => "not json" });
    await expect(readSelectedText(garbled.options)).resolves.toMatchObject({ kind: "failed" });
  });

  it("returns the copied selection and restores every pasteboard item and representation", () => {
    const value = (text: string) => ({ text, isNil: () => false });
    const array = <A>(items: A[]) => ({
      count: items.length,
      isNil: () => false,
      objectAtIndex: (index: number) => items[index],
    });
    const original: Record<string, ReturnType<typeof value>>[] = [
      {
        "public.utf8-plain-text": value("Original clipboard"),
        "public.html": value("<b>Original</b>"),
      },
      { "public.png": value("original image bytes") },
    ];
    let contents: Record<string, ReturnType<typeof value>>[] = original;
    const board = {
      changeCount: 0,
      get pasteboardItems() {
        return array(
          contents.map((item) => ({
            types: array(Object.keys(item)),
            dataForType: (type: string) => item[type],
          })),
        );
      },
      stringForType: (type: string) => contents[0]![type],
      get clearContents() {
        contents = [];
        return ++this.changeCount;
      },
      writeObjects: (items: { values: typeof contents }) => {
        contents = items.values;
      },
    };
    const objc = Object.assign((text: string) => text, {
      NSPasteboard: { generalPasteboard: board },
      NSPasteboardTypeString: "public.utf8-plain-text",
      NSMutableArray: {
        get array() {
          const values: typeof contents = [];
          return {
            values,
            get count() {
              return values.length;
            },
            addObject: (item: (typeof contents)[number]) => values.push(item),
          };
        },
      },
      NSPasteboardItem: {
        alloc: {
          get init() {
            const item: (typeof contents)[number] = {};
            Object.defineProperty(item, "setDataForType", {
              value: (data: ReturnType<typeof value>, type: string) => {
                item[type] = data;
              },
            });
            return item;
          },
        },
      },
      NSWorkspace: {
        sharedWorkspace: {
          frontmostApplication: { isNil: () => false, localizedName: value("Safari") },
        },
      },
      AXUIElementCreateSystemWide: () => ({}),
      AXUIElementCopyAttributeValue: () => 1,
      CGEventCreateKeyboardEvent: (_source: unknown, _key: number, down: boolean) => ({ down }),
      CGEventSetFlags: () => {},
      CGEventPost: (_tap: unknown, event: { down: boolean }) => {
        if (!event.down) {
          contents = [{ "public.utf8-plain-text": value("Selected words") }];
          board.changeCount++;
        }
      },
    });
    const output: unknown = runInNewContext(`${SELECTED_TEXT_SCRIPT}\nrun(["copy"]);`, {
      $: objc,
      ObjC: { import: () => {}, unwrap: (wrapped: ReturnType<typeof value>) => wrapped.text },
      Ref: () => [],
      delay: () => {},
    });
    if (typeof output !== "string") throw new Error("Expected selected-text JSON");
    expect(JSON.parse(output)).toEqual({
      text: "Selected words",
      application: "Safari",
      source: "clipboard",
    });
    expect(contents).toEqual(original);
  });
});
