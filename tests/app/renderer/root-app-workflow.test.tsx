/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
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
const newChat = (project: string) =>
  screen.getByRole("button", { name: `Start new chat in ${project}` });

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
      request.path === "/beta"
        ? preparing.promise
        : Promise.resolve({ ...request, trustRequired: false }),
    );
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () => ({
      ...defaultApplicationState(),
      projects: rootAppProjects,
    }));
    using fixture = renderRootAppWorkflow({ workspaces: { inspect, registerProject } });
    await fixture.user.type(input(), "Current draft");
    await fixture.user.click(newChat("beta"));
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    expect(input().value).toBe("Current draft");
    expect(screen.getAllByText("Current conversation").length).toBeGreaterThan(1);
    const request = inspect.mock.calls[0]?.[0];
    if (!request) throw new Error("Expected preparation request");
    await act(async () => preparing.resolve({ ...request, trustRequired: false }));
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in Beta…"));
    expect(input().value).toBe("");
    await fixture.user.type(input(), "Beta staged draft");
    await fixture.user.click(newChat("alpha"));
    await waitFor(() => expect(input().placeholder).toBe("Ask Cake to work in Alpha…"));
    await fixture.user.type(input(), "Alpha staged draft");
    await fixture.user.click(newChat("alpha"));
    expect(input().value).toBe("Alpha staged draft");
    await fixture.user.click(newChat("beta"));
    await waitFor(() => expect(input().value).toBe("Beta staged draft"));
    await fixture.user.click(newChat("alpha"));
    await waitFor(() => expect(input().value).toBe("Alpha staged draft"));
    expect(inspect.mock.calls.map(([request]) => request.path)).toEqual(["/beta", "/alpha"]);
  });

  it("retires the last resolved session and returns to an empty staged project composer", async () => {
    const resolve = vi.fn<Client["projectSessions"]["resolve"]>(async () => undefined);
    using fixture = renderRootAppWorkflow({ projectSessions: { resolve } });
    await fixture.user.type(input(), "Old draft");
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Current conversation" }));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith(
        { sessionId: rootAppSession.sessionId, workingDirectory: "/alpha" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(await screen.findByText("New chat")).toBeDefined();
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("Ask Cake to work in Alpha…");
    fixture.publishSessions([{ ...rootAppSession, resolved: true }]);
    expect(screen.queryByRole("button", { name: "Resolve Current conversation" })).toBeNull();
  });

  it("removes the active project's sessions only after delete-on-remove succeeds and returns to the empty workbench", async () => {
    const removed = deferred<ReturnType<typeof defaultApplicationState>>();
    const removeProject = vi.fn<Client["workspaces"]["removeProject"]>(() => removed.promise);
    const showProjectContextMenu = vi.fn<Client["electron"]["showProjectContextMenu"]>(
      async () => "remove-project",
    );
    using fixture = renderRootAppWorkflow({
      electron: { showProjectContextMenu },
      workspaces: { removeProject },
    });
    await fixture.user.pointer({ target: newChat("alpha"), keys: "[MouseRight]" });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Alpha?" });
    await fixture.user.click(
      within(dialog).getByRole("button", { name: "Remove and delete sessions" }),
    );
    await waitFor(() =>
      expect(removeProject).toHaveBeenCalledWith(
        "/alpha",
        true,
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
    expect(screen.queryByRole("button", { name: "Start new chat in alpha" })).toBeNull();
  });
});
