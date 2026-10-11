/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
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
    // Closing the browser restores the session's still-open artifact list.
    await fixture.user.click(screen.getByRole("button", { name: "Browse all artifacts" }));
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
