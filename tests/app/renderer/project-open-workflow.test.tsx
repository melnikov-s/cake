/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { App } from "../../../src/renderer/components/app";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";
import { projectRecord } from "./fixtures/catalog-fixtures";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderProjectOpen(
  client: TestClientOverrides = {},
  projects: ReturnType<typeof projectRecord>[] = [],
) {
  const fixture = createRendererStoreFixture({
    projects,
    client: {
      ...client,
      electron: { chooseProject: async () => "/work/cake", ...client.electron },
      workspaces: {
        loadStagedSlashCommands: async () => [],
        inspect: async (request) => ({ ...request, trustRequired: true }),
        ...client.workspaces,
      },
    },
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  // jsdom has no SVG layout or media-query engine; keep decorative avatars stationary.
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

describe("Project opening workflow", () => {
  it("uses only the latest folder-picker result", async () => {
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    const chooseProject = vi
      .fn<Client["electron"]["chooseProject"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (request) => ({
      ...request,
      trustRequired: false,
    }));
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({
      electron: { chooseProject },
      workspaces: { inspect, registerProject },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await act(async () => second.resolve("/second"));
    expect(await screen.findByPlaceholderText("Ask Cake to work in second…")).toBeDefined();
    await act(async () => first.resolve("/first"));
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/second" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByPlaceholderText("Ask Cake to work in second…")).toBeDefined();
  });

  it("rejects superseded inspection and registration results while opening the latest project", async () => {
    type Inspection = Awaited<ReturnType<Client["workspaces"]["inspect"]>>;
    const firstInspection = deferred<Inspection>();
    const secondRegistration = deferred<ReturnType<typeof defaultApplicationState>>();
    const chooseProject = vi
      .fn<Client["electron"]["chooseProject"]>()
      .mockResolvedValueOnce("/first")
      .mockResolvedValueOnce("/second")
      .mockResolvedValueOnce("/third");
    const inspect = vi.fn<Client["workspaces"]["inspect"]>((request) =>
      request.path === "/first"
        ? firstInspection.promise
        : Promise.resolve({ ...request, trustRequired: false }),
    );
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>((path) =>
      path === "/second" ? secondRegistration.promise : Promise.resolve(defaultApplicationState()),
    );
    using fixture = renderProjectOpen({
      electron: { chooseProject },
      workspaces: { inspect, registerProject },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() =>
      expect(registerProject).toHaveBeenCalledWith("/second", "second", expect.anything()),
    );
    await act(async () =>
      firstInspection.resolve({ ...inspect.mock.calls[0]![0], trustRequired: true }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in third…")).toBeDefined();
    await act(async () => secondRegistration.resolve(defaultApplicationState()));
    expect(screen.getByPlaceholderText("Ask Cake to work in third…")).toBeDefined();
    expect(registerProject.mock.calls.map(([path]) => path)).toEqual(["/second", "/third"]);
  });

  it("cancels pending inspection when the user starts a new chat in the already-open project", async () => {
    type Inspection = Awaited<ReturnType<Client["workspaces"]["inspect"]>>;
    const pending = deferred<Inspection>();
    const inspect = vi.fn<Client["workspaces"]["inspect"]>((request) =>
      request.path === "/existing"
        ? Promise.resolve({ ...request, trustRequired: false })
        : pending.promise,
    );
    const chooseProject = vi
      .fn<Client["electron"]["chooseProject"]>()
      .mockResolvedValueOnce("/existing")
      .mockResolvedValueOnce("/cancelled");
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen(
      { electron: { chooseProject }, workspaces: { inspect, registerProject } },
      [projectRecord({ path: "/existing", name: "Existing" })],
    );
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await fixture.user.click(screen.getByRole("button", { name: "New chat in existing" }));
    await act(async () => pending.resolve({ ...inspect.mock.calls[1]![0], trustRequired: true }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "Message" }).getAttribute("placeholder")).toBe(
      "Ask Cake to work in Existing…",
    );
  });

  it("opens a one-off staged conversation in the home directory without starting an agent", async () => {
    const getHomeDirectory = vi.fn<Client["application"]["getHomeDirectory"]>(
      async () => "/home/user",
    );
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    const start = vi.fn<Client["projectSessions"]["start"]>();
    using fixture = renderProjectOpen({
      application: { getHomeDirectory },
      projectSessions: { start },
      workspaces: {
        inspect: async (request) => ({ ...request, trustRequired: false }),
        registerProject,
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "One-off chat" }));
    expect(await screen.findByPlaceholderText("Ask Cake to work in user…")).toBeDefined();
    expect(registerProject).toHaveBeenCalledWith(
      "/home/user",
      "user",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getHomeDirectory).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
  it("opens a staged conversation only after trusting the workspace", async () => {
    const inspect = vi.fn<Client["workspaces"]["inspect"]>(async (request) => ({
      ...request,
      trustRequired: true,
    }));
    const respondToTrust = vi.fn<Client["workspaces"]["respondToTrust"]>(async () => undefined);
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({ workspaces: { inspect, respondToTrust, registerProject } });
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Trust this workspace?" });
    expect(registerProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Trust and open" }));
    await waitFor(() =>
      expect(registerProject).toHaveBeenCalledWith(
        "/work/cake",
        "cake",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(respondToTrust).toHaveBeenCalledWith({
      operationId: inspect.mock.calls[0]![0].operationId,
      path: "/work/cake",
      approved: true,
    });
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeDefined();
    expect(screen.getByPlaceholderText("Ask Cake to work in cake…")).toBeDefined();
  });
  it("declines an untrusted workspace without registering or opening it", async () => {
    const respondToTrust = vi.fn<Client["workspaces"]["respondToTrust"]>(async () => undefined);
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({ workspaces: { respondToTrust, registerProject } });
    await fixture.user.click(screen.getByRole("button", { name: "Open project" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Trust this workspace?" });
    expect(within(dialog).getByText(/\/work\/cake contains/)).toBeDefined();
    await fixture.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(respondToTrust).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/work/cake", approved: false }),
    );
    expect(registerProject).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "What should we build?" })).toBeDefined();
  });
});
