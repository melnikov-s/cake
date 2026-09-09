import { describe, expect, it } from "vitest";
import { searchSettings } from "../../../src/renderer/lib/settings-search";

describe("settings search", () => {
  it("returns the matching setting under its page", () => {
    expect(searchSettings("auto-hide")).toEqual([
      {
        page: "editor",
        label: "VS Code",
        items: [
          {
            page: "editor",
            label: "Auto-hide project sidebar",
            targetId: "setting-editor-sidebar-auto-hide",
            keywords: "embedded editor vscode",
          },
        ],
      },
    ]);
  });

  it("matches words across a setting label and its page metadata", () => {
    const results = searchSettings("agent retry");
    expect(results).toHaveLength(1);
    expect(results[0]?.items.map((item) => item.label)).toEqual(["Automatic retry"]);
  });

  it("includes dynamic settings such as individual hotkeys", () => {
    const results = searchSettings("toggle terminal", [
      {
        page: "hotkeys",
        label: "Toggle terminal",
        targetId: "setting-hotkey-toggle-terminal",
        keywords: "Show or hide the terminal",
      },
    ]);
    expect(results[0]?.label).toBe("Hotkeys");
    expect(results[0]?.items.map((item) => item.label)).toContain("Toggle terminal");
  });
});
