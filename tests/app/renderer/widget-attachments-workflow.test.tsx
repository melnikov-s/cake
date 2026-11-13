/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type ApplicationState as State,
} from "../../../src/contracts/application/application-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { WidgetSlot } from "../../../src/renderer/components/widget-slot";
import { WidgetPlacement } from "../../../src/renderer/components/widget-placement";
import { StoreProvider } from "r-state-tree/react";
import * as attachments from "../../../src/domain/widgets/widgetAttachments";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { widgetInstance } from "../helpers/widget-instance";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { artifactObserverWorkflowEvents } from "./artifact-observer-workflow-events";
import type { Client } from "../../../src/renderer/client/Client";
import type { ArtifactState } from "../../../src/contracts/artifacts/artifact-state";

const widget = widgetInstance();
const token = "00000000-0000-4000-8000-000000000010";
afterEach(cleanup);
function request(frame: HTMLIFrameElement, type: string, value: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      data: { source: "cake-inline-widget", token, type, value },
    }),
  );
}

async function setup() {
  let persisted = defaultApplicationState();
  let current: ArtifactState = {
    lineageId: widget.revision.lineageId,
    version: 1,
    value: { selected: "saved" },
  };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      ApplicationState.layer.pipe(
        Layer.provide(
          Layer.succeed(ApplicationStorage, {
            load: () => Effect.succeed({ state: persisted, source: "current" as const }),
            save: (state) =>
              Effect.sync(() => {
                persisted = state;
              }),
          }),
        ),
      ),
      Layer.mock(ArtifactStorage, { read: () => Effect.succeed(widget.revision) }),
    ),
  );
  await runtime.runPromise(Effect.flatMap(ApplicationState, (owner) => owner.initialize()));
  let revision = 0;
  const publish = (state: State) =>
    fixture.root.widgetAttachmentStore.applyApplicationState(++revision, state);
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
  const start = vi.fn<Client["cakeChats"]["start"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000002"),
  );
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
    TurnId.make("10000000-0000-4000-8000-000000000001"),
  );
  const fixture = createRendererStoreFixture({
    client: {
      application: {
        attachWidget: async (input) => publish(await runtime.runPromise(attachments.attach(input))),
        detachWidget: async ({ id }) => publish(await runtime.runPromise(attachments.detach(id))),
        setWidgetAttachmentHidden: async ({ id, hidden }) =>
          publish(await runtime.runPromise(attachments.setHidden(id, hidden))),
      },
      artifacts: {
        detail: async () => widget.detail,
        readExact: async () => widget.revision,
        stateRead: async () => current,
        stateReplace: async (input) => {
          if (input.expectedVersion !== current.version) throw new Error("State conflict");
          current = { ...current, version: current.version + 1, value: input.value };
          return current;
        },
      },
      inlineWidgets: { open: async () => ({ token, url: `cake-widget://document/${token}` }) },
      widgetUpdates: { events, poll },
      sessionChats: { prompt },
      cakeChats: { start },
    },
  });
  publish(
    await runtime.runPromise(
      attachments.attach({
        id: "shared",
        lineageId: widget.revision.lineageId,
        slot: "bottom",
        target: { kind: "global" },
      }),
    ),
  );
  return {
    fixture,
    runtime,
    prompt,
    start,
    stops,
    events,
    poll,
    persisted: () => persisted,
    current: () => current,
    async add(id: string, slot: "top" | "bottom") {
      publish(
        await runtime.runPromise(
          attachments.attach({
            id,
            lineageId: widget.revision.lineageId,
            slot,
            target: { kind: "global" },
          }),
        ),
      );
    },
    async [Symbol.asyncDispose]() {
      fixture[Symbol.dispose]();
      await runtime.dispose();
    },
  };
}

it("moves and remounts the same instance with saved state, and hiding releases every host subscription", async () => {
  await using f = await setup();
  const user = userEvent.setup();
  const session = { sessionId: "session-a", kind: "project-session" as const };
  const view = render(
    <StoreProvider store={f.fixture.root}>
      <WidgetPlacement>
        <div data-widget-chat>
          {(["top", "bottom", "left", "right"] as const).map((slot) => (
            <WidgetSlot
              key={slot}
              slot={slot}
              session={session}
              store={f.fixture.root.widgetAttachmentStore}
              widgets={f.fixture.root.inlineWidgetStore}
            />
          ))}
        </div>
      </WidgetPlacement>
    </StoreProvider>,
  );
  await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(1));
  let frame = view.container.querySelector("iframe")!;
  act(() =>
    request(frame, "artifact-state-replace", {
      id: "save",
      expectedVersion: 1,
      value: { selected: "edited" },
    }),
  );
  await waitFor(() => expect(f.current().value).toEqual({ selected: "edited" }));
  const chat = view.container.querySelector("[data-widget-chat]")!;
  vi.spyOn(chat, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 800,
  } as DOMRect);
  act(() => screen.getByRole("button", { name: "Move Fixture widget" }).focus());
  await user.keyboard("{Enter}{ArrowLeft}{Enter}");
  await waitFor(() =>
    expect(view.container.querySelector('[data-widget-slot="left"] iframe')).not.toBeNull(),
  );
  expect(f.persisted().widgetAttachments[0]).toMatchObject({
    id: "shared",
    lineageId: widget.revision.lineageId,
    slot: "left",
  });
  frame = view.container.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  act(() => {
    request(frame, "artifact-state-read", { id: "restored" });
    request(frame, "widget-subscribe", {
      id: "event",
      subscriptionId: "event",
      kind: "event",
      topic: "session.transcript.changed",
      filter: { sessionId: session.sessionId },
    });
    request(frame, "widget-subscribe", {
      id: "poll",
      subscriptionId: "poll",
      kind: "poll",
      options: { key: "sessions", command: "sessions.list", input: {}, intervalMs: 1000 },
    });
  });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state-result",
        value: expect.objectContaining({
          state: expect.objectContaining({ value: { selected: "edited" } }),
        }),
      }),
      "*",
    ),
  );
  expect(f.events).toHaveBeenCalledTimes(1);
  expect(f.poll).toHaveBeenCalledWith(
    expect.objectContaining({ lineageId: widget.revision.lineageId }),
    expect.any(Function),
    expect.any(Function),
  );
  expect(f.poll.mock.calls[0]?.[0].sessionId).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Widget options for Fixture widget" }));
  await user.click(screen.getByRole("button", { name: "Hide" }));
  await waitFor(() => expect(view.container.querySelector("iframe")).toBeNull());
  expect(f.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  expect(f.persisted().widgetAttachments[0]?.hidden).toBe(true);
  await user.click(screen.getByRole("button", { name: "Show" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  await user.click(screen.getByRole("button", { name: "Widget options for Fixture widget" }));
  await user.click(screen.getByRole("button", { name: "Close Fixture widget" }));
  await waitFor(() => expect(view.container.querySelector("iframe")).toBeNull());
  expect(f.current().value).toEqual({ selected: "edited" });
  view.unmount();
});

it("cancels keyboard placement and reorders in place without replacing the iframe", async () => {
  await using f = await setup();
  await f.add("second-view", "bottom");
  const user = userEvent.setup();
  const view = render(
    <StoreProvider store={f.fixture.root}>
      <WidgetPlacement>
        <div data-widget-chat>
          <WidgetSlot
            slot="bottom"
            session={{ sessionId: "one", kind: "project-session" }}
            store={f.fixture.root.widgetAttachmentStore}
            widgets={f.fixture.root.inlineWidgetStore}
          />
        </div>
      </WidgetPlacement>
    </StoreProvider>,
  );
  const chat = view.container.querySelector("[data-widget-chat]")!;
  vi.spyOn(chat, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 800,
  } as DOMRect);
  const panel = view.container.querySelector('[data-widget-attachment="shared"]')!;
  await waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
  const iframe = panel.querySelector("iframe");
  const before = f.persisted().widgetAttachments;
  const header = panel.querySelector<HTMLButtonElement>(
    'button[aria-label="Move Fixture widget"]',
  )!;
  act(() => header.focus());
  await user.keyboard("{Enter}{ArrowLeft}{Escape}");
  expect(f.persisted().widgetAttachments).toEqual(before);
  expect(document.querySelector("[data-widget-placement-overlay]")).toBeNull();
  await user.keyboard("{Enter}{PageDown}{Enter}");
  await waitFor(() =>
    expect(f.persisted().widgetAttachments.map((entry) => entry.id)).toEqual([
      "second-view",
      "shared",
    ]),
  );
  expect(panel.querySelector("iframe")).toBe(iframe);
  expect(iframe?.isConnected).toBe(true);
  view.unmount();
});

it("shares instance state while delivering different current sessions to each view", async () => {
  await using f = await setup();
  await f.add("second-view", "top");
  const view = render(
    <>
      <WidgetSlot
        slot="bottom"
        session={{ sessionId: "one", kind: "project-session" }}
        store={f.fixture.root.widgetAttachmentStore}
        widgets={f.fixture.root.inlineWidgetStore}
      />
      <WidgetSlot
        slot="top"
        session={{ sessionId: "two", kind: "project-chat" }}
        store={f.fixture.root.widgetAttachmentStore}
        widgets={f.fixture.root.inlineWidgetStore}
      />
    </>,
  );
  await using events = artifactObserverWorkflowEvents(f.fixture.root);
  await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(2));
  const [first, second] = [...view.container.querySelectorAll("iframe")];
  const a = vi.spyOn(first!.contentWindow!, "postMessage"),
    b = vi.spyOn(second!.contentWindow!, "postMessage");
  act(() => {
    request(first!, "ready", true);
    request(second!, "ready", true);
  });
  expect(a).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "context",
      value: expect.objectContaining({ session: { sessionId: "one", kind: "project-session" } }),
    }),
    "*",
  );
  expect(b).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "context",
      value: expect.objectContaining({ session: { sessionId: "two", kind: "project-chat" } }),
    }),
    "*",
  );
  act(() =>
    request(first!, "artifact-state-replace", {
      id: "save",
      expectedVersion: 1,
      value: { selected: "shared-edit" },
    }),
  );
  await waitFor(() => expect(f.current().version).toBe(2));
  await act(() =>
    events.emit({ type: "artifact-state-invalidated", lineageId: widget.revision.lineageId }),
  );
  await waitFor(() =>
    expect(b).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "state",
        value: expect.objectContaining({ value: { selected: "shared-edit" } }),
      }),
      "*",
    ),
  );
  view.unmount();
});

it.each([true, false])(
  "isolates a crash and repairs through Global Cake Chat (materialized=%s)",
  async (materialized) => {
    await using f = await setup();
    const user = userEvent.setup();
    const view = render(
      <WidgetSlot
        slot="bottom"
        session={{ sessionId: "one", kind: "project-session" }}
        store={f.fixture.root.widgetAttachmentStore}
        widgets={f.fixture.root.inlineWidgetStore}
      />,
    );
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    act(() => {
      request(frame, "widget-subscribe", {
        id: "event",
        subscriptionId: "event",
        kind: "event",
        topic: "session.changed",
        filter: {},
      });
      request(frame, "error", "Error: fixture crash");
    });
    await screen.findByText("Error: fixture crash");
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(f.stops[0]).toHaveBeenCalledTimes(1);
    if (materialized) {
      f.fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
      applySnapshot(f.fixture.models.cakeChatCatalog, {
        loaded: true,
        sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
      });
      const chat = f.fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
      applyConversationUpdate(chat.model, {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: CAKE_CHAT_SESSION_ID,
          sessionFile: "/cake-chat.sqlite",
          parts: [],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: false,
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      });
    }
    await user.click(screen.getByRole("button", { name: "Repair" }));
    await waitFor(() => expect(f.prompt.mock.calls.length + f.start.mock.calls.length).toBe(1));
    const repair = materialized ? f.prompt.mock.calls[0]?.[0] : f.start.mock.calls[0]?.[0];
    expect(repair).toMatchObject({
      sessionId: CAKE_CHAT_SESSION_ID,
      text: expect.stringContaining("fixture crash"),
    });
    expect(repair?.text).toContain("cake://artifact/widget-fixture@r1");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    expect(f.current().value).toEqual({ selected: "saved" });
    view.unmount();
  },
);
