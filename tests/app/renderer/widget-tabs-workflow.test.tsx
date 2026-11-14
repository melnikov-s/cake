/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { WidgetAttachment } from "../../../src/contracts/widgets/widget-attachment";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { WidgetTabHost } from "../../../src/renderer/components/widget-tab-host";
import { WorkspaceNavigator } from "../../../src/renderer/components/workspace-navigator";
import { WorkspaceCompanion } from "../../../src/renderer/components/workspace-companion";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { widgetInstance } from "../helpers/widget-instance";
import type { Client } from "../../../src/renderer/client/Client";

const token = "00000000-0000-4000-8000-000000000010";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function request(frame: HTMLIFrameElement, type: string, value: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { source: "cake-inline-widget", token, type, value },
    }),
  );
}

function setup(snapshot?: StoreSnapshot) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const records = [
    ["first", "Activity monitor"],
    ["second", "A long widget title that must remain inspectable without widening the pane"],
  ].map(([id, title]) => {
    const widget = widgetInstance(id);
    return {
      ...widget,
      revision: { ...widget.revision, snapshot: { ...widget.revision.snapshot, title } },
    };
  });
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const events = vi.fn<Client["widgetUpdates"]["events"]>(() => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  const poll = vi.fn<Client["widgetUpdates"]["poll"]>(() => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  const open = vi.fn<Client["inlineWidgets"]["open"]>(async () => ({
    token,
    url: `cake-widget://document/${token}`,
  }));
  const fixture = createRendererStoreFixture({
    snapshot,
    client: {
      artifacts: {
        detail: async (id) => records.find((item) => item.revision.lineageId === id)!.detail,
        readExact: async (id) => records.find((item) => item.revision.lineageId === id)!.revision,
        stateRead: async (input) => ({
          lineageId: input.lineageId,
          version: 1,
          value: { saved: true },
        }),
      },
      inlineWidgets: { open },
      widgetUpdates: { events, poll },
    },
  });
  let revision = 0;
  const entries: WidgetAttachment[] = records.map((item, index) => ({
    id: item.revision.lineageId,
    lineageId: item.revision.lineageId,
    target: { kind: "global" },
    slot: "tab",
    order: index,
    hidden: false,
  }));
  const publish = (attachments: WidgetAttachment[]) =>
    fixture.root.widgetAttachmentStore.applyApplicationState(++revision, {
      ...defaultApplicationState(),
      widgetAttachments: attachments,
    });
  publish(entries);
  return { fixture, entries, publish, events, poll, stops, open, records };
}

it("filters global tab widgets, keeps hidden widgets reachable, and falls back after removal", async () => {
  const f = setup();
  using fixture = f.fixture;
  const user = userEvent.setup();
  const view = render(
    <StoreProvider store={fixture.root}>
      <WidgetTabHost>
        <WorkspaceNavigator />
      </WidgetTabHost>
    </StoreProvider>,
  );
  await screen.findByRole("button", { name: "Widget tabs" });
  await waitFor(() => expect(fixture.root.widgetAttachmentStore.artifacts.size).toBe(2));
  const base = f.entries[0]!;
  act(() =>
    f.publish([
      base,
      { ...base, id: "other-slot", slot: "right" },
      { ...base, id: "session-scoped", target: { kind: "session", sessionId: "one" } },
      { ...base, id: "category-scoped", target: { kind: "project-chats" } },
      { ...f.entries[1]!, hidden: true },
      { ...base, id: "duplicate-lineage" },
    ]),
  );
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
    "Activity monitor",
    f.records[1]!.revision.snapshot.title,
  ]);
  await user.click(screen.getByRole("menuitemradio", { name: "Activity monitor" }));
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(true);
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  expect(
    screen.getByRole("menuitemradio", { name: "Activity monitor" }).getAttribute("aria-checked"),
  ).toBe("true");
  await user.keyboard("{Escape}");
  act(() => f.publish([]));
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  expect(screen.queryByRole("button", { name: /^Widget tabs/ })).toBeNull();
  expect(screen.getByRole("button", { name: /To-dos/ }).getAttribute("aria-pressed")).toBe("true");
  expect(view.container.querySelectorAll("iframe")).toHaveLength(0);
  view.unmount();
});

it("preserves one active view per global tab through keyboard/built-in/context/companion switches without restarting subscriptions", async () => {
  const f = setup();
  using fixture = f.fixture;
  const user = userEvent.setup();
  const layout = (companion = false) => (
    <StrictMode>
      <StoreProvider store={fixture.root}>
        <WidgetTabHost>
          {companion ? (
            <WorkspaceCompanion>
              <div>Chat fixture</div>
            </WorkspaceCompanion>
          ) : (
            <WorkspaceNavigator />
          )}
        </WidgetTabHost>
      </StoreProvider>
    </StrictMode>
  );
  const view = render(layout());
  await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(2));
  const frames = [...view.container.querySelectorAll("iframe")];
  const opened = f.open.mock.calls.length;
  // Both views are alive before ever being selected.
  for (const frame of frames)
    act(() =>
      request(frame, "widget-subscribe", {
        id: "poll",
        subscriptionId: "poll",
        kind: "poll",
        options: { key: "sessions", command: "sessions.list", input: {}, intervalMs: 1000 },
      }),
    );
  expect(f.poll).toHaveBeenCalledTimes(2);
  expect(f.events).not.toHaveBeenCalled();
  expect(f.poll.mock.calls.every(([input]) => input.sessionId === undefined)).toBe(true);
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(2));
  await user.keyboard("{Home}{Enter}");
  expect(fixture.root.workspaceNavigatorStore.selectedWidget?.id).toBe("first");
  await user.click(screen.getByRole("button", { name: /^Sessions ·/ }));
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  expect(fixture.root.workspaceNavigatorStore.mode).toBe("sessions");
  await user.click(screen.getByRole("button", { name: /To-dos/ }));
  expect(fixture.root.workspaceNavigatorStore.mode).toBe("todos");
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  // Home/ArrowDown: End now lands on Clear.
  await user.keyboard("{Home}{ArrowDown}{Enter}");
  expect(fixture.root.workspaceNavigatorStore.selectedWidget?.id).toBe("second");
  const title = f.records[1]!.revision.snapshot.title!;
  expect(screen.getByRole("button", { name: `Widget tab: ${title}` }).title).toBe(title);
  const post = vi.spyOn(frames[1]!.contentWindow!, "postMessage");
  act(() => {
    fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    request(frames[1]!, "ready", true);
  });
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "context",
      value: expect.objectContaining({
        session: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat" },
      }),
    }),
    "*",
  );
  act(() => fixture.root.workspaceNavigatorStore.close());
  view.rerender(layout(true));
  act(() => fixture.root.workspaceNavigatorStore.showWidget("second"));
  expect(screen.getByRole("button", { name: `Widget tab: ${title}` })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  view.rerender(layout());
  act(() => fixture.root.workspaceNavigatorStore.show("sessions"));
  act(() => fixture.root.workspaceNavigatorStore.showWidget("second"));
  act(() => f.publish([f.entries[0]!]));
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  expect(fixture.root.workspaceNavigatorStore.mode).toBe("sessions");
  expect(view.container.querySelector("iframe")).toBe(frames[0]);
  expect(frames[1]!.isConnected).toBe(false);
  expect(f.open).toHaveBeenCalledTimes(opened);
  expect(f.poll).toHaveBeenCalledTimes(2);
  expect(f.stops[0]).not.toHaveBeenCalled();
  expect(f.stops[1]).toHaveBeenCalledTimes(1);
  act(() => f.publish([{ ...f.entries[0]!, hidden: true }]));
  expect(f.stops[0]).toHaveBeenCalledTimes(1);
  view.unmount();
});

function renderNavigator(fixture: ReturnType<typeof setup>["fixture"]) {
  return render(
    <StoreProvider store={fixture.root}>
      <WidgetTabHost>
        <WorkspaceNavigator />
      </WidgetTabHost>
    </StoreProvider>,
  );
}

const pressed = (name: string | RegExp) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

it("keeps scoped tabs alive while unselected, releases them outside applicability, and restores selection/state on return", async () => {
  const f = setup();
  using fixture = f.fixture;
  act(() => {
    fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    f.publish([
      { ...f.entries[0]!, target: { kind: "session", sessionId: CAKE_CHAT_SESSION_ID } },
      f.entries[1]!,
    ]);
  });
  const view = renderNavigator(fixture);
  await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(2));
  const scoped = view.container.querySelector('[data-widget-attachment="first"]')!;
  const original = scoped.querySelector("iframe")!;
  act(() => {
    fixture.root.workspaceNavigatorStore.showWidget("first");
    request(original, "widget-subscribe", {
      id: "poll",
      subscriptionId: "poll",
      kind: "poll",
      options: { key: "sessions", command: "sessions.list", input: {}, intervalMs: 1000 },
    });
  });
  expect(f.poll.mock.calls[0]?.[0].sessionId).toBe(CAKE_CHAT_SESSION_ID);
  act(() => fixture.root.workspaceNavigatorStore.showWidget("second"));
  expect(original.isConnected).toBe(true);
  expect(f.stops[0]).not.toHaveBeenCalled();
  act(() => fixture.root.workspaceNavigatorStore.showWidget("first"));
  act(() => {
    fixture.root.appShellStore.workspace = "home";
  });
  expect(fixture.root.widgetAttachmentStore.availableTabWidgets.map((entry) => entry.id)).toEqual([
    "second",
  ]);
  expect(fixture.root.workspaceNavigatorStore.selectedWidget).toBeUndefined();
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  expect(view.container.querySelector('[data-widget-attachment="first"]')).toBeNull();
  expect(original.isConnected).toBe(false);
  expect(f.stops[0]).toHaveBeenCalledTimes(1);
  act(() => fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID));
  await waitFor(() =>
    expect(view.container.querySelector('[data-widget-attachment="first"] iframe')).not.toBeNull(),
  );
  expect(fixture.root.workspaceNavigatorStore.selectedWidget?.id).toBe("first");
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(true);
  const restored = view.container.querySelector(
    '[data-widget-attachment="first"] iframe',
  ) as HTMLIFrameElement;
  const post = vi.spyOn(restored.contentWindow!, "postMessage");
  act(() => request(restored, "artifact-state-read", { id: "restored" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state-result",
        value: expect.objectContaining({
          state: expect.objectContaining({ value: { saved: true } }),
        }),
      }),
      "*",
    ),
  );
  act(() =>
    f.publish([
      {
        ...f.entries[0]!,
        target: { kind: "session", sessionId: CAKE_CHAT_SESSION_ID },
        hidden: true,
      },
      f.entries[1]!,
    ]),
  );
  expect(restored.isConnected).toBe(false);
  expect(fixture.root.workspaceNavigatorStore.selectedWidget?.hidden).toBe(true);
  expect(
    view.container.querySelector(
      '[data-widget-attachment="first"] button[aria-label="Widget options for Activity monitor"]',
    ),
  ).not.toBeNull();
  view.unmount();
});

it("keeps the picked widget on its tab across To-dos/Sessions switches until Clear", async () => {
  const f = setup();
  using fixture = f.fixture;
  const user = userEvent.setup();
  const view = renderNavigator(fixture);
  await waitFor(() => expect(fixture.root.widgetAttachmentStore.artifacts.size).toBe(2));
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Activity monitor" }));
  expect(pressed("Widget tab: Activity monitor")).toBe("true");

  await user.click(screen.getByRole("button", { name: /To-dos/ }));
  expect(screen.getByRole("searchbox", { name: "Search to-dos" })).toBeDefined();
  // The tab still names the widget; one click shows it again, without the menu.
  expect(pressed("Widget tab: Activity monitor")).toBe("false");
  await user.click(screen.getByRole("button", { name: "Widget tab: Activity monitor" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(true);
  expect(pressed(/To-dos/)).toBe("false");
  expect(view.container.querySelector('[data-slot="widget-tab-viewport"]')).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /^Sessions ·/ }));
  await user.click(screen.getByRole("button", { name: "Widget tab: Activity monitor" }));
  expect(fixture.root.workspaceNavigatorStore.selectedWidget?.id).toBe("first");

  // The chevron still rebinds the tab.
  const second = f.records[1]!.revision.snapshot.title!;
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  await user.click(screen.getByRole("menuitemradio", { name: second }));
  expect(pressed(`Widget tab: ${second}`)).toBe("true");

  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  await user.click(screen.getByRole("menuitem", { name: "Clear" }));
  expect(fixture.root.workspaceNavigatorStore.widgetId).toBeNull();
  expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
  expect(pressed(/^Sessions ·/)).toBe("true");
  expect(screen.queryByRole("button", { name: /^Widget tab:/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Widget tabs" }));
  // Nothing to clear in the default state.
  expect(screen.queryByRole("menuitem", { name: "Clear" })).toBeNull();
  expect(
    screen.getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-checked")),
  ).toEqual(["false", "false"]);
  view.unmount();
});

it("restores the picked widget after reload and falls back when it no longer exists", async () => {
  let saved: StoreSnapshot;
  {
    const f = setup();
    using fixture = f.fixture;
    act(() => fixture.root.workspaceNavigatorStore.showWidget("second"));
    saved = toSnapshot(fixture.root) ?? {};
  }
  {
    const f = setup(saved);
    using fixture = f.fixture;
    const user = userEvent.setup();
    const view = renderNavigator(fixture);
    const title = f.records[1]!.revision.snapshot.title!;
    // Startup still opens To-dos, with the tab bound to the saved widget.
    await screen.findByRole("button", { name: `Widget tab: ${title}` });
    expect(pressed(/To-dos/)).toBe("true");
    await user.click(screen.getByRole("button", { name: `Widget tab: ${title}` }));
    expect(fixture.root.workspaceNavigatorStore.selectedWidget?.id).toBe("second");
    expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(true);

    // Detaching it while shown falls back to the built-in view and the default picker.
    act(() => f.publish([f.entries[0]!]));
    expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
    expect(pressed(/To-dos/)).toBe("true");
    expect(screen.queryByRole("button", { name: /^Widget tab:/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Widget tabs" }).textContent).toBe("Widgets");
    act(() => fixture.root.workspaceNavigatorStore.showWidget());
    expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
    // A returning widget is not shown again uninvited.
    act(() => f.publish(f.entries));
    expect(fixture.root.workspaceNavigatorStore.showingWidget).toBe(false);
    view.unmount();
  }
  {
    // A stale saved id from a deleted widget renders the default state without errors.
    const navigator = saved.children?.workspaceNavigatorStore as StoreSnapshot;
    const f = setup({
      ...saved,
      children: {
        ...saved.children,
        workspaceNavigatorStore: { ...navigator, state: { ...navigator.state, widgetId: "gone" } },
      },
    });
    using fixture = f.fixture;
    const view = renderNavigator(fixture);
    await screen.findByRole("button", { name: "Widget tabs" });
    expect(screen.queryByRole("button", { name: /^Widget tab:/ })).toBeNull();
    expect(fixture.root.workspaceNavigatorStore.selectedWidget).toBeUndefined();
    expect(pressed(/To-dos/)).toBe("true");
    view.unmount();
  }
});
