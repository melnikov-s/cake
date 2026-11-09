/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { applySnapshot } from "r-state-tree";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptyProjectTodos,
  type ProjectTodos,
} from "../../../src/contracts/projects/project-todos";
import type { Client } from "../../../src/renderer/client/Client";
import {
  editorLease,
  editorSessionId,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

it.each(["browser", "vscode"] as const)(
  "%s companion shares Project Chat to-dos and sessions without replacing its workspace",
  async (mode) => {
    let todos: ProjectTodos = {
      ...emptyProjectTodos(),
      items: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          title: "Project-owned task",
          description: "Shared with Project Chat",
          status: "",
          state: "open",
          revision: 0,
          associations: [],
        },
      ],
    };
    const project = () => ({ ...projectRecord({ path: "/project", name: "Project" }), todos });
    const browserState = {
      sessionId: editorSessionId,
      url: "https://example.com/current-page",
      title: "Current page",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      inspecting: false,
    };
    const openEditor = vi.fn<Client["vscode"]["open"]>(async () => editorLease("a"));
    const releaseEditor = vi.fn<Client["vscode"]["release"]>(async () => undefined);
    const openBrowser = vi.fn<Client["browser"]["open"]>(async () => browserState);
    const mutate = vi.fn<Client["projectTodos"]["mutateUser"]>(async ({ mutation }) => {
      if (mutation._tag === "SetState") {
        todos = {
          ...todos,
          items: todos.items.map((item) => ({
            ...item,
            state: mutation.state,
            revision: item.revision + 1,
          })),
        };
        applySnapshot(fixture.models.projects, { projects: [project()] });
      }
      return todos;
    });
    using fixture = renderEmbeddedEditor({
      vscode: { open: openEditor, release: releaseEditor },
      browser: { open: openBrowser, updateBounds: async () => browserState },
      projectTodos: { mutateUser: mutate },
    });
    act(() => {
      applySnapshot(fixture.models.projects, { projects: [project()] });
      applySnapshot(fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [
          { sessionId: "project-chat:/project", title: "Project Chat", projectPath: "/project" },
        ],
      });
    });
    await fixture.user.click(
      screen.getByRole("button", {
        name: mode === "browser" ? "Browser" : "VS Code",
      }),
    );
    const workspace =
      mode === "browser"
        ? await screen.findByLabelText("Browser viewport")
        : await screen.findByTitle("VS Code workspace");
    const companion = within(
      screen.getByRole("complementary", { name: "Current conversation companion" }),
    );
    const tabs = within(companion.getByRole("group", { name: "Companion content" }));
    const surface = document.querySelector('[data-slot="workspace-companion-content"]')!;
    expect(surface.classList.contains("bg-sidebar")).toBe(false);
    expect(tabs.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    await fixture.user.click(tabs.getByRole("button", { name: "Todos" }));
    await fixture.user.hover(companion.getByRole("button", { name: "Project-owned task" }));
    expect(await screen.findByText("Shared with Project Chat")).toBeDefined();
    expect(surface.classList.contains("bg-sidebar")).toBe(true);
    await fixture.user.click(
      companion.getByRole("button", { name: "Mark done: Project-owned task" }),
    );
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "/project",
          mutation: expect.objectContaining({ _tag: "SetState", state: "done" }),
        }),
        expect.anything(),
      ),
    );
    await fixture.user.click(tabs.getByRole("button", { name: "Sessions" }));
    expect(surface.classList.contains("bg-sidebar")).toBe(true);
    expect(
      within(companion.getByRole("region", { name: "Sessions" })).getByText("Editor conversation"),
    ).toBeDefined();
    await fixture.user.click(tabs.getByRole("button", { name: "Chat" }));
    expect(surface.classList.contains("bg-sidebar")).toBe(false);
    expect(tabs.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      expect(
        await fixture.root.applicationControlStore.invoke({
          name: "app.workspace",
          arguments: { mode: "todos", visible: true },
        }),
      ).toMatchObject({ ok: true, workspace: { visible: true, mode: "todos" } });
    });
    expect(tabs.getByRole("button", { name: "Todos" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      expect(
        await fixture.root.applicationControlStore.invoke({
          name: "app.workspace",
          arguments: { visible: false },
        }),
      ).toMatchObject({ ok: true, workspace: { visible: false } });
    });
    expect(tabs.getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    expect(
      mode === "browser"
        ? screen.getByLabelText("Browser viewport")
        : screen.getByTitle("VS Code workspace"),
    ).toBe(workspace);
    if (mode === "browser") {
      expect(
        (screen.getByRole("textbox", { name: "Browser address" }) as HTMLInputElement).value,
      ).toBe(browserState.url);
      expect(openBrowser).toHaveBeenCalledTimes(1);
    } else {
      expect(workspace.getAttribute("src")).toBe(editorLease("a").endpoint);
      expect(openEditor).toHaveBeenCalledTimes(1);
      expect(releaseEditor).not.toHaveBeenCalled();
    }
    await fixture.user.click(screen.getByRole("button", { name: "Main" }));
    act(() => fixture.root.navigationStore.selectCakeChat("project-chat:/project"));
    const navigator = within(screen.getByRole("complementary", { name: "Workspace" }));
    await fixture.user.click(navigator.getByRole("button", { name: /^To-dos/ }));
    await fixture.user.click(navigator.getByRole("button", { name: "Done (1)" }));
    expect(
      await navigator.findByRole("button", { name: "Reopen: Project-owned task" }),
    ).toBeDefined();
  },
);
