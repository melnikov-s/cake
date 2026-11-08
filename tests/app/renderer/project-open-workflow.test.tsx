/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { Client } from "../../../src/renderer/client/Client";
import { createSessionInProject } from "./workspace-navigation-actions";
import { App } from "../../../src/renderer/components/app";
import { NewSessionDialog } from "../../../src/renderer/components/new-session-dialog";
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
        inspect: async (request) => ({ ...request }),
        ...client.workspaces,
      },
    },
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <App />
      <NewSessionDialog store={fixture.root.newSessionStore} />
    </StoreProvider>,
  );
  return {
    root: fixture.root,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function confirmAdd(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog", { name: "Add project" });
  await user.click(within(dialog).getByRole("button", { name: "Add project" }));
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
    }));
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({
      electron: { chooseProject },
      workspaces: { inspect, registerProject },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await act(async () => second.resolve("/second"));
    await confirmAdd(fixture.user);
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
      request.path === "/first" ? firstInspection.promise : Promise.resolve({ ...request }),
    );
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>((path) =>
      path === "/second" ? secondRegistration.promise : Promise.resolve(defaultApplicationState()),
    );
    using fixture = renderProjectOpen({
      electron: { chooseProject },
      workspaces: { inspect, registerProject },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await confirmAdd(fixture.user);
    await waitFor(() =>
      expect(registerProject).toHaveBeenCalledWith(
        "/second",
        "second",
        expect.anything(),
        expect.objectContaining({ worktreeLanding: "merge" }),
      ),
    );
    await act(async () => firstInspection.resolve({ ...inspect.mock.calls[0]![0] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(() => fixture.root.navigationStore.chooseProject());
    await confirmAdd(fixture.user);
    expect(await screen.findByPlaceholderText("Ask Cake to work in third…")).toBeDefined();
    await act(async () => secondRegistration.resolve(defaultApplicationState()));
    expect(screen.getByPlaceholderText("Ask Cake to work in third…")).toBeDefined();
    expect(registerProject.mock.calls.map(([path]) => path)).toEqual(["/second", "/third"]);
  });

  it("cancels pending inspection when the user starts a new chat in the already-open project", async () => {
    type Inspection = Awaited<ReturnType<Client["workspaces"]["inspect"]>>;
    const pending = deferred<Inspection>();
    const inspect = vi.fn<Client["workspaces"]["inspect"]>((request) =>
      request.path === "/existing" ? Promise.resolve({ ...request }) : pending.promise,
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
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    await createSessionInProject(fixture.user, /^Existing/i);
    await act(async () => pending.resolve({ ...inspect.mock.calls[1]![0] }));
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
        inspect: async (request) => ({ ...request }),
        registerProject,
      },
    });
    // The former landing-page button is gone; exercise the retained explicit navigation operation.
    await act(() => fixture.root.navigationStore.startOneOffChat());
    expect(await screen.findByPlaceholderText("Ask Cake to work in user…")).toBeDefined();
    expect(registerProject).toHaveBeenCalledWith(
      "/home/user",
      "user",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getHomeDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(start).not.toHaveBeenCalled();
  });
  it("opens the picker first, then a prefilled dialog and adds with one click without a model call", async () => {
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>();
    using fixture = renderProjectOpen({ workspaces: { registerProject, generateProjectIcon } });
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = await screen.findByRole("dialog", { name: "Add project" });
    expect(within(dialog).getByRole("textbox", { name: "Project name" })).toHaveProperty(
      "value",
      "cake",
    );
    expect(within(dialog).getByText("/work/cake")).toBeDefined();
    expect(within(dialog).getByRole("radio", { name: "Merge with Cake" })).toHaveProperty(
      "checked",
      true,
    );
    expect(registerProject).not.toHaveBeenCalled();
    expect(generateProjectIcon).not.toHaveBeenCalled();
    await confirmAdd(fixture.user);
    expect(await screen.findByPlaceholderText("Ask Cake to work in cake…")).toBeDefined();
    expect(registerProject).toHaveBeenCalledWith(
      "/work/cake",
      "cake",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({ worktreeLanding: "merge" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("cancels a customized draft without registering a project or persisting settings", async () => {
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>();
    const setProjectSettings = vi.fn<Client["workspaces"]["setProjectSettings"]>();
    const generateProjectIcon = vi.fn<Client["workspaces"]["generateProjectIcon"]>();
    using fixture = renderProjectOpen({
      workspaces: { registerProject, setProjectSettings, generateProjectIcon },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add project" }));
    await fixture.user.clear(dialog.getByRole("textbox", { name: "Project name" }));
    await fixture.user.type(dialog.getByRole("textbox", { name: "Project name" }), "Personal name");
    await fixture.user.click(dialog.getByRole("radio", { name: "Merge outside Cake" }));
    await fixture.user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
    expect(registerProject).not.toHaveBeenCalled();
    expect(setProjectSettings).not.toHaveBeenCalled();
    expect(generateProjectIcon).not.toHaveBeenCalled();
    expect(fixture.root.projectCatalogStore.projects).toHaveLength(0);
  });

  it("adds the inspected canonical folder with the chosen display name, local icon and external workflow atomically", async () => {
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({
      filesystem: {
        chooseAttachments: async () => [
          { kind: "image", name: "icon.png", mimeType: "image/png", data: "aWNvbg==" },
        ],
      },
      workspaces: {
        inspect: async (request) => ({
          operationId: request.operationId,
          path: "/canonical/folder",
        }),
        registerProject,
      },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add project" }));
    expect(dialog.getByText("/canonical/folder")).toBeDefined();
    expect(dialog.getByRole("textbox", { name: "Project name" })).toHaveProperty("value", "folder");
    await fixture.user.clear(dialog.getByRole("textbox", { name: "Project name" }));
    await fixture.user.type(dialog.getByRole("textbox", { name: "Project name" }), "Atlas");
    await fixture.user.click(dialog.getByRole("button", { name: "Choose icon…" }));
    await fixture.user.click(dialog.getByRole("radio", { name: "Merge outside Cake" }));
    expect(registerProject).not.toHaveBeenCalled();
    await confirmAdd(fixture.user);
    await waitFor(() => expect(registerProject).toHaveBeenCalledOnce());
    expect(registerProject).toHaveBeenCalledWith(
      "/canonical/folder",
      "Atlas",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({
        worktreeLanding: "pull-request",
        icon: { mimeType: "image/png", data: "aWNvbg==" },
      }),
    );
  });

  it("opens an already registered picker result without duplicating or reconfiguring it", async () => {
    const registerProject = vi.fn<Client["workspaces"]["registerProject"]>(async () =>
      defaultApplicationState(),
    );
    using fixture = renderProjectOpen({ workspaces: { registerProject } }, [
      projectRecord({ path: "/work/cake", name: "Existing display name" }),
    ]);
    await fixture.user.click(screen.getByRole("button", { name: "Add project" }));
    expect(
      await screen.findByPlaceholderText("Ask Cake to work in Existing display name…"),
    ).toBeDefined();
    expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
    expect(registerProject).toHaveBeenCalledWith(
      "/work/cake",
      "Existing display name",
      expect.anything(),
    );
  });
});
