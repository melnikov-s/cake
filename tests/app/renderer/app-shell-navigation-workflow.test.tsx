/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
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

const back = () => screen.getByRole("button", { name: "Go back in session history" });
const forward = () => screen.getByRole("button", { name: "Go forward in session history" });
const settings = () => screen.getAllByRole("button", { name: "Open settings" })[0]!;
const openLibrary = async (user: ReturnType<typeof renderAppShellNavigation>["user"]) => {
  if (!screen.queryByRole("button", { name: "Browse all artifacts" })) {
    await user.click(screen.getByRole("button", { name: /^(?:\d+ artifacts|Artifacts)$/ }));
  }
  await user.click(screen.getByRole("button", { name: "Browse all artifacts" }));
};
const sessionButton = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name} conversation `) });
const cakeChatButton = () => screen.getByRole("button", { name: "Cake Chat" });
const expectProjectChat = async (name: string) => {
  expect(await screen.findByPlaceholderText(`Ask Cake to work in ${name}…`)).toBeDefined();
};
const expectCakeChat = async () => {
  expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
};

// The artifact browser exposes the shell's conversation history; workbench Back/Forward
// first traverses pane-local history (covered by project-navigation/workbench workflows).
describe("App shell navigation workflow", () => {
  it.each(
    (["project", "cake-chat"] as const).flatMap((workspace) =>
      (["settings", "artifact-library"] as const).map((cover) => ({ workspace, cover })),
    ),
  )(
    "persisted-window restore keeps $workspace under its $cover cover",
    async ({ workspace, cover }) => {
      let saved: StoreSnapshot;
      {
        using fixture = renderAppShellNavigation();
        await fixture.user.click(sessionButton("alpha"));
        await fixture.user.click(sessionButton("beta"));
        if (workspace === "cake-chat") {
          await fixture.user.click(cakeChatButton());
          await expectCakeChat();
        }
        if (cover === "settings") await fixture.user.click(settings());
        else await openLibrary(fixture.user);
        saved = toSnapshot(fixture.root);
      }
      using restored = renderAppShellNavigation({}, { snapshot: saved });
      if (cover === "settings") {
        expect(await screen.findByText("Model configuration")).toBeDefined();
        await restored.user.click(screen.getByRole("button", { name: "Back to chat" }));
      } else {
        expect(await screen.findByText("No artifacts match this view.")).toBeDefined();
        await restored.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
      }
      if (workspace === "cake-chat") await expectCakeChat();
      else await expectProjectChat("beta");
      // Window visits survive covering/restoration without becoming pane-local history.
      await openLibrary(restored.user);
      await restored.user.click(back());
      await expectProjectChat(workspace === "cake-chat" ? "beta" : "alpha");
      await openLibrary(restored.user);
      await restored.user.click(forward());
      if (workspace === "cake-chat") await expectCakeChat();
      else await expectProjectChat("beta");
    },
  );

  it("traverses project and Cake Chat visits without recording reselections and truncates a divergent forward branch", async () => {
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderAppShellNavigation({ projectSessions: { open } });
    expect(back()).toHaveProperty("disabled", true);
    expect(forward()).toHaveProperty("disabled", true);
    await fixture.user.click(sessionButton("alpha"));
    await expectProjectChat("alpha");
    await fixture.user.click(sessionButton("alpha"));
    await fixture.user.click(cakeChatButton());
    await expectCakeChat();
    await fixture.user.click(cakeChatButton());
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectProjectChat("alpha");
    expect(back()).toHaveProperty("disabled", true);
    expect(forward()).toHaveProperty("disabled", false);
    await openLibrary(fixture.user);
    await fixture.user.click(forward());
    await expectCakeChat();
    expect(forward()).toHaveProperty("disabled", true);

    await fixture.user.click(sessionButton("beta"));
    await expectProjectChat("beta");
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectCakeChat();
    await fixture.user.click(sessionButton("gamma"));
    await expectProjectChat("gamma");
    expect(forward()).toHaveProperty("disabled", true);
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(forward());
    await expectProjectChat("gamma");

    // Selecting an earlier visited session directly is a new visit, not a traversal.
    await fixture.user.click(sessionButton("alpha"));
    await expectProjectChat("alpha");
    expect(forward()).toHaveProperty("disabled", true);
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectProjectChat("gamma");
    expect(open).toHaveBeenCalledWith(
      { sessionId: "gamma", workingDirectory: "/gamma" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("skips newly resolved project visits in both directions but retains the permanent Cake Chat", async () => {
    using fixture = renderAppShellNavigation();
    await fixture.user.click(sessionButton("alpha"));
    await fixture.user.click(sessionButton("beta"));
    await fixture.user.click(cakeChatButton());
    await fixture.user.click(sessionButton("gamma"));
    await fixture.publishResolved("beta");
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectProjectChat("alpha");
    expect(back()).toHaveProperty("disabled", true);
    await openLibrary(fixture.user);
    await fixture.user.click(forward());
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(forward());
    await expectProjectChat("gamma");
    expect(forward()).toHaveProperty("disabled", true);
  });

  it("keeps an archived preview out of history until restoration is published", async () => {
    const restore = vi.fn<Client["projectSessions"]["restore"]>(async () => undefined);
    using fixture = renderAppShellNavigation(
      { projectSessions: { restore } },
      { resolvedIds: ["beta"] },
    );
    await fixture.user.click(sessionButton("alpha"));
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand beta resolved" })[0]!);
    await fixture.user.click(sessionButton("beta"));
    await expectProjectChat("beta");
    expect(back()).toHaveProperty("disabled", true);
    expect(forward()).toHaveProperty("disabled", true);
    await fixture.user.click(screen.getByRole("button", { name: "Restore beta conversation" }));
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "beta", workingDirectory: "/beta" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Successful RPC alone must not promote an archived preview.
    expect(back()).toHaveProperty("disabled", true);
    await fixture.publishResolved("beta", false);
    await openLibrary(fixture.user);
    await fixture.user.click(back());
    await expectProjectChat("alpha");
    expect(back()).toHaveProperty("disabled", true);
    await openLibrary(fixture.user);
    await fixture.user.click(forward());
    await expectProjectChat("beta");
    expect(forward()).toHaveProperty("disabled", true);
  });

  it("deletes an archived preview and returns to the retained visit without recording the preview", async () => {
    const deleteSession = vi.fn<Client["workspaces"]["deleteSession"]>(async (sessionId) => {
      await fixture.publishRemoved(sessionId);
      return defaultApplicationState();
    });
    using fixture = renderAppShellNavigation(
      {
        electron: { showSessionContextMenu: async () => ({ action: "delete" }) },
        workspaces: { deleteSession },
      },
      { resolvedIds: ["beta"] },
    );
    await fixture.user.click(sessionButton("alpha"));
    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(screen.getAllByRole("button", { name: "Expand beta resolved" })[0]!);
    await fixture.user.click(sessionButton("beta"));
    await expectProjectChat("beta");
    await fixture.user.pointer({ target: sessionButton("beta"), keys: "[MouseRight]" });
    await waitFor(() =>
      expect(deleteSession).toHaveBeenCalledWith(
        "beta",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await expectProjectChat("alpha");
    expect(back()).toHaveProperty("disabled", true);
    expect(forward()).toHaveProperty("disabled", true);
  });

  it.each([false, true])(
    "commits history only when a deferred destination lands and discards a superseded traversal (diverge: %s)",
    async (diverge) => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const open = vi.fn<Client["projectSessions"]["open"]>((request) =>
        request.sessionId === "beta" ? pending : Promise.resolve(),
      );
      using fixture = renderAppShellNavigation(
        { projectSessions: { open } },
        { history: ["alpha", "beta", "gamma"], unhydratedIds: ["beta"] },
      );
      await openLibrary(fixture.user);
      await fixture.user.click(back());
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          { sessionId: "beta", workingDirectory: "/beta" },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(forward()).toHaveProperty("disabled", true);
      if (diverge) {
        await fixture.user.click(sessionButton("alpha"));
        await expectProjectChat("alpha");
      }
      await act(async () => finish());
      await fixture.publishHydrated("beta");
      await expectProjectChat(diverge ? "alpha" : "beta");
      expect(forward()).toHaveProperty("disabled", diverge);
      await openLibrary(fixture.user);
      await fixture.user.click(diverge ? back() : forward());
      await expectProjectChat("gamma");
      expect(forward()).toHaveProperty("disabled", diverge ? false : true);
    },
  );

  it("returns from Settings and the artifact browser to the same project or Cake Chat and retains current-chat settings", async () => {
    const catalog = vi.fn<Client["artifacts"]["catalog"]>(async (request) => ({
      offset: request.offset ?? 0,
      limit: request.limit ?? 50,
      items: [],
      total: 0,
      hasMore: false,
    }));
    using fixture = renderAppShellNavigation({ artifacts: { catalog } });
    await fixture.user.click(sessionButton("alpha"));
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectProjectChat("alpha");
    await openLibrary(fixture.user);
    expect(await screen.findByText("No artifacts match this view.")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Search artifact library" })).toBeDefined();
    expect(catalog).toHaveBeenCalledWith(
      { search: "", offset: 0, limit: 50 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    await expectProjectChat("alpha");
    // The artifact popover closes when browsing; reopen it from the same session.
    await openLibrary(fixture.user);
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectProjectChat("alpha");

    await fixture.user.click(cakeChatButton());
    await fixture.user.click(settings());
    expect(await screen.findByText("Model configuration")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    await expectCakeChat();
    await openLibrary(fixture.user);
    await fixture.user.click(screen.getByRole("button", { name: "Close all artifacts" }));
    await expectCakeChat();
  });
});
