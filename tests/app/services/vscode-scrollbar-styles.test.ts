import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { vscodeShellControlsScript } from "../../../src/services/vscode/vscode-view-scripts";
import scrollbarStyles from "../../../src/utils/scrollbars.css?raw";

it("installs the shared scrollbar presentation once in managed VS Code", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "outside-only",
  });
  try {
    const script = vscodeShellControlsScript("/workspace", false);
    dom.window.eval(script);
    dom.window.eval(script);
    const styles = dom.window.document.querySelectorAll("#cake-scrollbar-styles");
    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toBe(scrollbarStyles);
  } finally {
    dom.window.close();
  }
});
