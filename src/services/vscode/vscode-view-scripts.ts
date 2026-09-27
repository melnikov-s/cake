import cakeIconMarkup from "../../assets/cake-icon.svg?raw";

export const VSCODE_BACKGROUND = { dark: "#121519", light: "#f5f7f9" } as const;
const WORKBENCH_LAYOUT_READY_TIMEOUT_MS = 10_000;
// VS Code exposes editor-title actions to extensions, but those disappear when no
// file is open and it has no public top-level title-bar contribution point. Cake
// owns this managed web surface, so install its shell controls alongside the
// corresponding native title-bar controls and keep them present across rerenders.
export const VSCODE_SHELL_CONTROL_PREFIX = "__CAKE_SHELL_CONTROL__";

export function waitForWorkbenchLayoutScript(theme: "light" | "dark") {
  const themeClass = theme === "dark" ? "vs-dark" : "vs";
  return `new Promise((resolve) => {
    let timeout;
    const matches = () => {
      const workbench = document.querySelector(".monaco-workbench.${themeClass}");
      const sidebar = document.querySelector(".monaco-workbench .part.sidebar");
      if (!(workbench instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return false;
      const bounds = sidebar.getBoundingClientRect();
      return bounds.width === 0 || bounds.height === 0;
    };
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true,
    });
    timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, ${WORKBENCH_LAYOUT_READY_TIMEOUT_MS});
    if (matches()) {
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    }
  })`;
}

export function projectSidebarVisibilityScript(visible: boolean) {
  return `(() => {
    window.__cakeProjectSidebarVisible = ${JSON.stringify(visible)};
    const control = document.getElementById("cake-toggle-project-sidebar");
    if (!control) return;
    control.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
  })()`;
}

export function vscodeShellControlsScript(workspacePath: string, projectSidebarVisible: boolean) {
  return `(() => {
    const cakeIconMarkup = ${JSON.stringify(cakeIconMarkup)};
    const controlPrefix = ${JSON.stringify(VSCODE_SHELL_CONTROL_PREFIX)};
    const workspace = ${JSON.stringify(workspacePath)};
    window.__cakeProjectSidebarVisible = ${JSON.stringify(projectSidebarVisible)};
    const controls = [
      ["cake-back-to-agent", "Cake: Back to Agent", "cake", "back-to-agent", "start"],
      [
        "cake-toggle-project-sidebar",
        "Cake: Toggle Sessions Sidebar",
        "layout-sidebar-left",
        "toggle-project-sidebar",
        "start",
      ],
      [
        "cake-toggle-chat-sidebar",
        "Cake: Toggle Chat Sidebar",
        "layout-sidebar-right",
        "toggle-chat-sidebar",
        "end",
      ],
    ];
    const install = () => {
      const actions = document.querySelector(
        ".part.titlebar .titlebar-right .action-toolbar-container .actions-container",
      );
      const commandCenter = document.querySelector(".part.titlebar .command-center");
      const navigationActions = commandCenter?.querySelector(
        ":scope > .monaco-toolbar > .monaco-action-bar > .actions-container",
      );
      if (!(actions instanceof HTMLElement)) return;
      const projectSidebarActions =
        navigationActions instanceof HTMLElement ? navigationActions : actions;
      const secondarySidebarAction = actions.querySelector(
        '[aria-label*="Toggle Secondary Side Bar"], [title*="Toggle Secondary Side Bar"]',
      );
      secondarySidebarAction?.closest(".action-item")?.remove();
      for (const [id, label, icon, type, placement] of controls) {
        const existing = document.getElementById(id);
        if (existing) {
          if (id === "cake-toggle-project-sidebar") {
            existing.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
            if (
              existing.parentElement !== projectSidebarActions ||
              projectSidebarActions.firstElementChild !== existing
            ) {
              projectSidebarActions.prepend(existing);
            }
          }
          continue;
        }
        const item = document.createElement("li");
        item.id = id;
        item.className = "action-item";
        if (id === "cake-toggle-project-sidebar") {
          item.style.display = window.__cakeProjectSidebarVisible ? "none" : "flex";
        }
        const action = document.createElement("a");
        action.className = icon === "cake" ? "action-label" : "action-label codicon codicon-" + icon;
        if (icon === "cake") {
          action.innerHTML = cakeIconMarkup + "<span>Back to Agent</span>";
          action.style.alignItems = "center";
          action.style.color = "var(--vscode-titleBar-activeForeground)";
          action.style.gap = "6px";
          action.style.padding = "0 8px";
        }
        action.href = "#";
        action.addEventListener("click", (event) => {
          event.preventDefault();
          if (type === "toggle-project-sidebar") item.style.display = "none";
          console.debug(controlPrefix + JSON.stringify({ type, workspace }));
        });
        action.setAttribute("role", "button");
        action.setAttribute("aria-label", label);
        action.title = label;
        item.append(action);
        if (id === "cake-toggle-project-sidebar") projectSidebarActions.prepend(item);
        else if (placement === "start") actions.prepend(item);
        else actions.append(item);
      }
    };
    install();
    if (!window.__cakeShellControlsObserver) {
      window.__cakeShellControlsObserver = new MutationObserver(install);
      window.__cakeShellControlsObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  })()`;
}
