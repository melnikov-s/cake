/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
});

function controls() {
  const group = screen.getByRole("group", { name: "Conversation history" });
  expect(group.closest('[data-slot="workspace-header"]')).not.toBeNull();
  return {
    back: within(group).getByRole<HTMLButtonElement>("button", {
      name: "Go back in session history",
    }),
    forward: within(group).getByRole<HTMLButtonElement>("button", {
      name: "Go forward in session history",
    }),
  };
}

async function expectSession(sessionId: string, draft?: string) {
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="session-pane"]')?.getAttribute("data-session-id"),
    ).toBe(sessionId),
  );
  expect(screen.getByRole("navigation", { name: "Conversation breadcrumb" }).textContent).toContain(
    `${sessionId} conversation`,
  );
  const composer = await screen.findByPlaceholderText(`Ask Cake to work in ${sessionId}…`);
  if (draft !== undefined) expect(composer).toHaveProperty("value", draft);
}

it("restores accessible header controls with disabled boundaries, draft retention and unchanged shortcuts", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha"] });
  expect(controls().back.disabled).toBe(true);
  expect(controls().forward.disabled).toBe(true);
  await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Alpha draft");
  await fixture.selectSession("beta");
  await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Beta draft");
  expect(controls().back.disabled).toBe(false);
  expect(controls().forward.disabled).toBe(true);
  await fixture.user.click(controls().back);
  await expectSession("alpha", "Alpha draft");
  expect(controls().back.disabled).toBe(true);
  expect(controls().forward.disabled).toBe(false);
  await fixture.pressHistory("forward");
  await expectSession("beta", "Beta draft");
  await fixture.pressHistory("back");
  await expectSession("alpha", "Alpha draft");
  // Native button activation is available to keyboard users as well as pointer users.
  controls().forward.focus();
  await fixture.user.keyboard("{Enter}");
  await expectSession("beta", "Beta draft");
  expect(fixture.root.sessionLayoutStore.history).toEqual(["alpha", "beta"]);
  await fixture.user.click(controls().back);
  await expectSession("alpha");
  await fixture.selectSession("gamma");
  expect(controls().forward.disabled).toBe(true);
  expect(fixture.root.sessionLayoutStore.history).toEqual(["alpha", "gamma"]);
});

it("preserves pane-local traversal before returning through window history", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["alpha", "beta"] });
  await fixture.user.click(screen.getByRole("button", { name: "Open Cake Chat" }));
  expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  await fixture.user.click(controls().back);
  await expectSession("beta");
  await fixture.user.click(controls().back);
  await expectSession("alpha");
  await fixture.user.click(controls().forward);
  await expectSession("beta");
  await fixture.user.click(controls().forward);
  expect(await screen.findByRole("combobox", { name: "Message Cake Chat" })).toBeDefined();
  expect(controls().forward.disabled).toBe(true);
});

it("keeps an unavailable local history target from changing the header, composer or either cursor", async () => {
  const lookup = vi.fn<Client["projectSessions"]["lookup"]>(async () => {
    throw new Error("History target no longer exists");
  });
  using fixture = renderAppShellNavigation(
    { projectSessions: { lookup } },
    { history: ["alpha", "beta", "gamma"], unhydratedIds: ["beta"] },
  );
  await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Gamma draft");
  await fixture.user.click(controls().back);
  await screen.findByText("History target no longer exists");
  await expectSession("gamma", "Gamma draft");
  expect(fixture.root.sessionLayoutStore.historyCursor).toBe(2);
  expect(fixture.root.appShellStore.canGoForward).toBe(false);
  expect(controls().forward.disabled).toBe(true);
  expect(screen.queryByRole("combobox", { name: "Message Cake Chat" })).toBeNull();
  await fixture.user.click(controls().back);
  await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
  await expectSession("gamma", "Gamma draft");
});

it("does not let a deferred history visit hijack a newer selection or corrupt its forward branch", async () => {
  const pending = Promise.withResolvers<void>();
  const open = vi.fn<Client["projectSessions"]["open"]>(({ sessionId }) =>
    sessionId === "beta" ? pending.promise : Promise.resolve(),
  );
  using fixture = renderAppShellNavigation(
    { projectSessions: { open } },
    { history: ["alpha", "beta", "gamma"], unhydratedIds: ["beta"] },
  );
  await fixture.user.click(controls().back);
  await waitFor(() => expect(open).toHaveBeenCalled());
  await expectSession("gamma");
  expect(controls().forward.disabled).toBe(true);
  await fixture.selectSession("alpha");
  await act(async () => pending.resolve());
  await fixture.publishHydrated("beta");
  await expectSession("alpha");
  expect(fixture.root.sessionLayoutStore.history).toEqual(["alpha", "beta", "gamma", "alpha"]);
  expect(controls().forward.disabled).toBe(true);
});
