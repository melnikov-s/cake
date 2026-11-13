/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StoreProvider } from "r-state-tree/react";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { applySnapshot } from "r-state-tree";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "../../../src/contracts/artifacts/artifact-contract";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { WidgetAttachment } from "../../../src/contracts/widgets/widget-attachment";
import type { Client } from "../../../src/renderer/client/Client";
import { ArtifactHost } from "../../../src/renderer/components/artifact-host";
import { ArtifactAttachmentMenu } from "../../../src/renderer/components/artifact-attachment-menu";
import { widgetInstance } from "../helpers/widget-instance";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const widget = widgetInstance();
const record: ArtifactRecord = {
  artifact: widget.revision.snapshot,
  digest: "a".repeat(64),
  workspacePath: "/project",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
afterEach(cleanup);

function setup(initial: WidgetAttachment[] = []) {
  const attach = vi.fn<Client["application"]["attachWidget"]>(async (input) => {
    publish([
      ...fixture.root.widgetAttachmentStore.attachments.filter((entry) => entry.id !== input.id),
      {
        ...input,
        order: input.order ?? 0,
        hidden:
          fixture.root.widgetAttachmentStore.attachments.find((entry) => entry.id === input.id)
            ?.hidden ?? false,
      },
    ]);
  });
  const hide = vi.fn<Client["application"]["setWidgetAttachmentHidden"]>(async ({ id, hidden }) => {
    publish(
      fixture.root.widgetAttachmentStore.attachments.map((entry) =>
        entry.id === id ? { ...entry, hidden } : entry,
      ),
    );
  });
  const stateReplace = vi.fn<Client["artifacts"]["stateReplace"]>();
  const fixture = createRendererStoreFixture({
    client: {
      application: { attachWidget: attach, setWidgetAttachmentHidden: hide },
      electron: { setFullscreenSurfaceOpen: async () => undefined },
      artifacts: {
        stateRead: async () => ({
          lineageId: widget.revision.lineageId,
          version: 7,
          value: { count: 12 },
        }),
        stateReplace,
      },
      inlineWidgets: {
        open: async () => ({
          token: "00000000-0000-4000-8000-000000000010",
          url: "cake-widget://document/00000000-0000-4000-8000-000000000010",
        }),
      },
    },
  });
  let revision = 0;
  const publish = (widgetAttachments: WidgetAttachment[]) =>
    fixture.root.widgetAttachmentStore.applyApplicationState(++revision, {
      ...defaultApplicationState(),
      widgetAttachments,
    });
  publish(initial);
  const close = vi.fn();
  const show = (presentation: "side-panel" | "fullscreen" = "side-panel", value = record) =>
    render(
      <StrictMode>
        <StoreProvider store={fixture.root}>
          <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
            <ArtifactHost
              record={value}
              presentation={presentation}
              stateSessionId="viewing-session"
              inlineWidgets={fixture.root.inlineWidgetStore}
              onClose={close}
            />
          </StoreProvider>
        </StoreProvider>
      </StrictMode>,
    );
  return {
    fixture,
    attach,
    hide,
    close,
    show,
    stateReplace,
    [Symbol.dispose]() {
      cleanup();
      fixture[Symbol.dispose]();
    },
  };
}

it("offers all five destinations in the side-panel header and reuses the instance and placement ID", async () => {
  using f = setup();
  const user = userEvent.setup();
  const view = f.show();
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  const id = view.container
    .querySelector("[data-widget-view-id]")!
    .getAttribute("data-widget-view-id")!;
  await waitFor(() =>
    expect(f.fixture.root.inlineWidgetStore.artifactStates[id]?.current?.value).toEqual({
      count: 12,
    }),
  );
  await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
  for (const [slot, label] of [
    ["top", "Top"],
    ["bottom", "Bottom"],
    ["left", "Left"],
    ["right", "Right"],
    ["tab", "Workspace tab"],
  ] as const) {
    await user.click(screen.getByRole("menuitem", { name: label }));
    await waitFor(() =>
      expect(f.attach).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lineageId: widget.revision.lineageId,
          slot,
          target: { kind: "session", sessionId: "viewing-session" },
        }),
        expect.anything(),
      ),
    );
    expect(f.fixture.root.widgetAttachmentStore.attachments).toHaveLength(1);
    expect(view.container.querySelector("iframe")).toBe(frame);
  }
  expect(new Set(f.attach.mock.calls.map(([input]) => input.id)).size).toBe(1);
  expect(f.fixture.root.inlineWidgetStore.artifactStates[id]?.current?.value).toEqual({
    count: 12,
  });
  expect(f.stateReplace).not.toHaveBeenCalled();
});

it.each(["top", "bottom", "left", "right", "tab"] as const)(
  "moves an existing %s attachment without duplicating lineage or changing state",
  async (slot) => {
    using f = setup([
      {
        id: "existing",
        lineageId: widget.revision.lineageId,
        slot,
        target:
          slot === "tab" ? { kind: "global" } : { kind: "session", sessionId: "viewing-session" },
        order: 3,
        hidden: false,
      },
    ]);
    f.show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
    await user.click(
      screen.getByRole("menuitem", {
        name: slot === "tab" ? "Left" : "Workspace tab",
      }),
    );
    expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
      id: "existing",
      lineageId: widget.revision.lineageId,
      target:
        slot === "tab" ? { kind: "global" } : { kind: "session", sessionId: "viewing-session" },
    });
    expect(f.fixture.root.widgetAttachmentStore.attachments).toHaveLength(1);
    expect(f.stateReplace).not.toHaveBeenCalled();
  },
);

it("prefers the existing tab ID when the widget has multiple placements", async () => {
  using f = setup(
    (["left", "tab"] as const).map((slot) => ({
      id: slot,
      lineageId: widget.revision.lineageId,
      slot,
      target: { kind: "global" },
      order: 0,
      hidden: false,
    })),
  );
  await act(() =>
    f.fixture.root.widgetAttachmentStore.attachViewedWidget(
      widget.revision.lineageId,
      "tab",
      "viewing-session",
    ),
  );
  expect(f.attach.mock.calls[0]?.[0].id).toBe("tab");
});

it("reveals a hidden existing placement when attaching it from the viewer", async () => {
  using f = setup([
    {
      id: "hidden-placement",
      lineageId: widget.revision.lineageId,
      slot: "left",
      target: { kind: "global" },
      order: 0,
      hidden: true,
    },
  ]);
  const hide = vi.spyOn(f.fixture.root.widgetAttachmentStore, "hide").mockResolvedValue();
  await act(() =>
    f.fixture.root.widgetAttachmentStore.attachViewedWidget(
      widget.revision.lineageId,
      "tab",
      "viewing-session",
    ),
  );
  expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
    id: "hidden-placement",
    slot: "tab",
    target: { kind: "global" },
  });
  expect(hide).toHaveBeenCalledWith("hidden-placement", false);
});

it("supports keyboard navigation and Escape in fullscreen without closing the viewer", async () => {
  using f = setup();
  f.show("fullscreen");
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Attach Fixture widget to" });
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Top" }));
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Workspace tab" }));
  await user.keyboard("{Enter}");
  expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
    slot: "tab",
    target: { kind: "session", sessionId: "viewing-session" },
  });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

it("shows pending and failure feedback, blocks duplicate requests and allows retry", async () => {
  using f = setup();
  let fail!: (error: Error) => void;
  f.attach.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  f.show();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
  await user.click(screen.getByRole("menuitem", { name: "Top" }));
  expect(screen.getByRole("status").textContent).toBe("Attaching…");
  expect(screen.getByRole("menuitem", { name: "Workspace tab" }).hasAttribute("disabled")).toBe(
    true,
  );
  await act(() =>
    f.fixture.root.widgetAttachmentStore.attachViewedWidget(
      widget.revision.lineageId,
      "tab",
      "viewing-session",
    ),
  );
  expect(f.attach).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("Attachment request failed")));
  expect((await screen.findByRole("alert")).textContent).toContain("Attachment request failed");
  await user.click(screen.getByRole("menuitem", { name: "Workspace tab" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(f.attach).toHaveBeenCalledTimes(2);
});

it.each(["side-panel", "fullscreen"] as const)(
  "does not expose attachment actions for static artifacts in %s",
  (presentation) => {
    using f = setup();
    f.show(presentation, {
      ...record,
      artifact: { ...record.artifact, kind: "markdown", payload: { markdown: "Static report" } },
    });
    expect(screen.queryByRole("button", { name: /Attach .* to/ })).toBeNull();
  },
);

it.each(["left", "tab"] as const)(
  "rejects session A -> B reuse of a hidden %s placement without writes or stale success",
  async (slot) => {
    const initial: WidgetAttachment[] = [
      {
        id: "session-a",
        lineageId: widget.revision.lineageId,
        target: { kind: "session", sessionId: "session-a" },
        slot,
        order: 2,
        hidden: true,
      },
    ];
    using f = setup(initial);
    const user = userEvent.setup();
    f.show();
    act(() =>
      f.fixture.root.widgetAttachmentStore.placementRequests.set(widget.revision.lineageId, {
        pending: false,
        slot: "left",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
    expect(screen.getByRole("status").textContent).toBe("Attached to Left.");
    await user.click(screen.getByRole("menuitem", { name: "Workspace tab" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Widget scope conflict");
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.hide).not.toHaveBeenCalled();
    expect(f.stateReplace).not.toHaveBeenCalled();
    expect(f.fixture.root.widgetAttachmentStore.attachments).toEqual(initial);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      f.fixture.root.widgetAttachmentStore.placementRequests.get(widget.revision.lineageId),
    ).toEqual({ pending: false, error: expect.stringContaining("Nothing was changed") });
  },
);

it.each(["project-chats", "project-sessions"] as const)(
  "rejects a %s category placement in Cake Chat without moving or unhiding it",
  async (kind) => {
    const initial: WidgetAttachment[] = [
      {
        id: "category",
        lineageId: widget.revision.lineageId,
        target: { kind },
        slot: "right",
        order: 1,
        hidden: true,
      },
    ];
    using f = setup(initial);
    act(() => f.fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID));
    render(
      <StoreProvider store={f.fixture.root}>
        <ArtifactAttachmentMenu artifact={record.artifact} sessionId={CAKE_CHAT_SESSION_ID} />
      </StoreProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
    await user.click(screen.getByRole("menuitem", { name: "Workspace tab" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Widget scope conflict");
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.hide).not.toHaveBeenCalled();
    expect(f.stateReplace).not.toHaveBeenCalled();
    expect(f.fixture.root.widgetAttachmentStore.attachments).toEqual(initial);
    expect(screen.queryByRole("status")).toBeNull();
  },
);

it.each(["session", "global"] as const)(
  "prefers a compatible %s placement over an incompatible tab, preserving the other conversation",
  async (kind) => {
    const outside: WidgetAttachment = {
      id: "outside",
      lineageId: widget.revision.lineageId,
      target: { kind: "session", sessionId: "session-a" },
      slot: "tab",
      order: 0,
      hidden: true,
    };
    const compatible: WidgetAttachment = {
      ...outside,
      id: "compatible",
      slot: "bottom",
      order: 1,
      target: kind === "session" ? { kind, sessionId: "viewing-session" } : { kind },
    };
    using f = setup([outside, compatible]);
    f.show();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
    await user.click(screen.getByRole("menuitem", { name: "Left" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Attached to Left."));
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
      id: compatible.id,
      lineageId: compatible.lineageId,
      target: compatible.target,
      slot: "left",
    });
    expect(f.hide).toHaveBeenCalledTimes(1);
    expect(f.hide.mock.calls[0]?.[0]).toEqual({ id: compatible.id, hidden: false });
    expect(
      f.fixture.root.widgetAttachmentStore.attachments.find((entry) => entry.id === outside.id),
    ).toEqual(outside);
    expect(f.fixture.root.widgetAttachmentStore.attachments).toHaveLength(2);
    expect(f.stateReplace).not.toHaveBeenCalled();
  },
);

it("moves only the compatible exact-session placement to Workspace among mixed scopes", async () => {
  const outside: WidgetAttachment = {
    id: "outside",
    lineageId: widget.revision.lineageId,
    target: { kind: "session", sessionId: "session-a" },
    slot: "left",
    order: 0,
    hidden: true,
  };
  const compatible: WidgetAttachment = {
    ...outside,
    id: "compatible",
    slot: "bottom",
    order: 1,
    target: { kind: "session", sessionId: "viewing-session" },
  };
  using f = setup([outside, compatible]);
  f.show();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
  await user.click(screen.getByRole("menuitem", { name: "Workspace tab" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Attached to Workspace tab."),
  );
  expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
    id: compatible.id,
    lineageId: compatible.lineageId,
    target: compatible.target,
    slot: "tab",
  });
  expect(f.hide.mock.calls[0]?.[0]).toEqual({ id: compatible.id, hidden: false });
  expect(
    f.fixture.root.widgetAttachmentStore.attachments.find((entry) => entry.id === outside.id),
  ).toEqual(outside);
  expect(f.fixture.root.widgetAttachmentStore.attachments).toHaveLength(2);
  expect(f.stateReplace).not.toHaveBeenCalled();
});

it("reuses an applicable category without globalizing it or reusing another session's tab", async () => {
  const sessionId = `project-chat:${"a".repeat(64)}`;
  const outside: WidgetAttachment = {
    id: "outside",
    lineageId: widget.revision.lineageId,
    target: { kind: "session", sessionId: "session-a" },
    slot: "tab",
    order: 0,
    hidden: true,
  };
  const compatible: WidgetAttachment = {
    ...outside,
    id: "category",
    target: { kind: "project-chats" },
    slot: "bottom",
    order: 1,
  };
  using f = setup([outside, compatible]);
  act(() => {
    applySnapshot(f.fixture.models.cakeChatCatalog, {
      loaded: true,
      sessions: [{ sessionId, title: "Project Chat" }],
    });
    f.fixture.root.navigationStore.selectCakeChat(sessionId);
  });
  render(
    <StoreProvider store={f.fixture.root}>
      <ArtifactAttachmentMenu artifact={record.artifact} sessionId={sessionId} />
    </StoreProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
  await user.click(screen.getByRole("menuitem", { name: "Top" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Attached to Top."));
  expect(f.attach.mock.calls[0]?.[0]).toMatchObject({
    id: compatible.id,
    lineageId: compatible.lineageId,
    target: compatible.target,
    slot: "top",
  });
  expect(f.hide.mock.calls[0]?.[0]).toEqual({ id: compatible.id, hidden: false });
  expect(
    f.fixture.root.widgetAttachmentStore.attachments.find((entry) => entry.id === outside.id),
  ).toEqual(outside);
  expect(f.stateReplace).not.toHaveBeenCalled();
});

it("allows only the global Workspace tab when no conversation scope is available", async () => {
  using f = setup();
  const user = userEvent.setup();
  render(
    <StoreProvider store={f.fixture.root}>
      <ArtifactAttachmentMenu artifact={record.artifact} />
    </StoreProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Attach Fixture widget to" }));
  for (const label of ["Top", "Bottom", "Left", "Right"])
    expect(screen.getByRole("menuitem", { name: label }).hasAttribute("disabled")).toBe(true);
  await user.click(screen.getByRole("menuitem", { name: "Workspace tab" }));
  expect(f.attach.mock.calls[0]?.[0]).toMatchObject({ slot: "tab", target: { kind: "global" } });
});
