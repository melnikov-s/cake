/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { createSessionInProject } from "./workspace-navigation-actions";
import {
  renderRootAppWorkflow,
  rootAppProjects,
  rootAppSession,
} from "./root-app-workflow-fixture";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const input = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// These are the remaining product journeys from RootStore's navigation suite.
// Existing shell/browser/editor/workbench suites own their surface transitions;
// agent-originated application-control transport contracts remain in RootStore.
describe("Root App workflow", () => {
  it("keeps the current chat during preparation, then restores each project's staged draft on repeated creation", async () => {
    type Inspection = Awaited<ReturnType<Client["workspaces"]["inspect"]>>;
    const preparing = deferred<Inspection>();
    const inspect = vi.fn<Client["workspaces"]["inspect"]>((request) =>
      request.path === "/beta" ? preparing.promise : Promise.resolve({ ...request }),
    );
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () => ({
      ...defaultApplicationState(),
      projects: rootAppProjects,
    }));
    using fixture = renderRootAppWorkflow({ workspaces: { inspect, registerProject } });
    await fixture.user.type(input(), "Current draft");
    await createSessionInProject(fixture.user, /^Beta/);
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    expect(input().value).toBe("Current draft");
    expect(
      screen.getByRole("navigation", { name: "Conversation breadcrumb" }).textContent,
    ).toContain("Current conversation");
    const request = inspect.mock.calls[0]?.[0];
    if (!request) throw new Error("Expected preparation request");
    await act(async () => preparing.resolve({ ...request }));
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in Beta…"));
    expect(input().value).toBe("");
    await fixture.user.type(input(), "Beta staged draft");
    await createSessionInProject(fixture.user, /^Alpha/);
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in Alpha…"));
    await fixture.user.type(input(), "Alpha staged draft");
    await createSessionInProject(fixture.user, /^Alpha/);
    expect(input().value).toBe("Alpha staged draft");
    await createSessionInProject(fixture.user, /^Beta/);
    await waitFor(() => expect(input().value).toBe("Beta staged draft"));
    await createSessionInProject(fixture.user, /^Alpha/);
    await waitFor(() => expect(input().value).toBe("Alpha staged draft"));
    expect(inspect.mock.calls.map(([request]) => request.path)).toEqual(["/beta", "/alpha"]);
  });

  it("retires the last resolved session and returns to its Project Chat", async () => {
    const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
    using fixture = renderRootAppWorkflow({ projectSessions: { resolve } });
    await fixture.user.type(input(), "Old draft");
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Current conversation" }));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        { sessionId: rootAppSession.sessionId, workingDirectory: "/alpha", userInitiated: true },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    const home = await screen.findByRole<HTMLTextAreaElement>("combobox", {
      name: "Message Project Chat",
    });
    expect(home.value).toBe("");
    expect(fixture.root.appShellStore.activeConversation).toEqual({
      kind: "cake-chat",
      sessionId: `project-chat:${"a".repeat(64)}`,
    });
    expect(fixture.root.sessionRegistry.findSession(rootAppSession.sessionId)).toBeUndefined();
    fixture.publishSessions([{ ...rootAppSession, resolved: true }]);
    expect(screen.queryByRole("button", { name: "Resolve Current conversation" })).toBeNull();
  });

  it.each([false, true])(
    "removes the active project only after success and returns to the empty workbench (deleteSessions: %s)",
    async (deleteSessions) => {
      const removed = deferred<ReturnType<typeof defaultApplicationState>>();
      const removeProject = vi.fn<Client["workspaces"]["removeProject"]>(() => removed.promise);
      const showProjectContextMenu = vi.fn<Client["electron"]["showProjectContextMenu"]>(
        async () => "remove-project",
      );
      using fixture = renderRootAppWorkflow({
        electron: { showProjectContextMenu },
        workspaces: { removeProject },
      });
      await fixture.user.pointer({
        target: screen.getByRole("button", { name: /Open Project Chat for Alpha/i }),
        keys: "[MouseRight]",
      });
      const dialog = await screen.findByRole("alertdialog", { name: "Remove Alpha?" });
      await fixture.user.click(
        within(dialog).getByRole("button", {
          name: deleteSessions ? "Remove and delete sessions" : "Remove only",
        }),
      );
      await waitFor(() =>
        expect(removeProject).toHaveBeenCalledWith(
          "/alpha",
          deleteSessions,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(input()).toBeDefined();
      const authority = {
        ...defaultApplicationState(),
        projects: rootAppProjects.filter((project) => project.path !== "/alpha"),
      };
      await act(async () => {
        removed.resolve(authority);
        await removed.promise;
      });
      fixture.publishProjects(authority.projects);
      fixture.publishSessions([]);
      expect(await screen.findByRole("heading", { name: "What should we build?" })).toBeDefined();
      expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Open Project Chat for Alpha/i })).toBeNull();
      expect(fixture.root.sessionRegistry.findSession(rootAppSession.sessionId)).toBeUndefined();
      expect(fixture.root.sessionLayoutStore.focusedSessionHistory).not.toContain(
        rootAppSession.sessionId,
      );
    },
  );
});
