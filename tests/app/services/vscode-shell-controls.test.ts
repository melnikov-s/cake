import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import {
  projectSidebarVisibilityScript,
  VSCODE_SHELL_CONTROL_PREFIX,
  vscodeShellControlsScript,
} from "../../../src/services/vscode/vscode-view-scripts";

it("retains the Sessions restore control and native layout actions without duplicate shell navigation", async () => {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
      <div class="part titlebar">
        <div class="command-center"><div class="monaco-toolbar"><div class="monaco-action-bar">
          <ul class="actions-container"><li id="navigation">Back</li></ul>
        </div></div></div>
        <div class="titlebar-right"><div class="action-toolbar-container"><ul class="actions-container">
          <li class="action-item" id="primary"><a aria-label="Toggle Primary Side Bar"></a></li>
          <li class="action-item" id="panel"><a aria-label="Toggle Panel"></a></li>
          <li class="action-item"><a aria-label="Toggle Secondary Side Bar"></a></li>
        </ul></div></div>
      </div>
    </body></html>`,
    { runScripts: "outside-only" },
  );
  try {
    const debug = vi.spyOn(dom.window.console, "debug").mockImplementation(() => undefined);
    const document = dom.window.document;
    const script = vscodeShellControlsScript("/workspace", false);
    dom.window.eval(script);
    dom.window.eval(script);
    const control = document.getElementById("cake-toggle-project-sidebar")!;
    expect(document.querySelectorAll("#cake-toggle-project-sidebar")).toHaveLength(1);
    expect(control.parentElement?.firstElementChild).toBe(control);
    expect(control.nextElementSibling?.id).toBe("navigation");
    expect(control.style.display).toBe("flex");
    expect(document.querySelector("#primary")).not.toBeNull();
    expect(document.querySelector("#panel")).not.toBeNull();
    expect(document.querySelector('[aria-label="Toggle Secondary Side Bar"]')).toBeNull();
    expect(document.querySelector("#cake-back-to-agent, #cake-toggle-chat-sidebar")).toBeNull();
    expect(document.body.textContent).not.toContain("Back to Agent");
    control.querySelector("a")!.click();
    expect(control.style.display).toBe("none");
    expect(debug).toHaveBeenCalledWith(
      VSCODE_SHELL_CONTROL_PREFIX +
        JSON.stringify({ type: "toggle-project-sidebar", workspace: "/workspace" }),
    );
    dom.window.eval(projectSidebarVisibilityScript(true));
    expect(control.style.display).toBe("none");
    dom.window.eval(projectSidebarVisibilityScript(false));
    expect(control.style.display).toBe("flex");

    // The workbench rerenders its toolbar; reinstall only the retained control.
    control.remove();
    await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
    expect(document.querySelectorAll("#cake-toggle-project-sidebar")).toHaveLength(1);
    expect(document.querySelector("#cake-back-to-agent, #cake-toggle-chat-sidebar")).toBeNull();
  } finally {
    dom.window.close();
  }
});
