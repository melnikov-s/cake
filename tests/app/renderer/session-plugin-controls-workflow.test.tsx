/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
  type SessionPlugin,
} from "../../../src/contracts/application/application-data";
import { ApplicationWriteError } from "../../../src/contracts/storage/application-storage-errors";
import {
  deleteSessionPlugin,
  setSessionPluginHidden,
} from "../../../src/domain/application/application";
import type { Client } from "../../../src/renderer/client/Client";
import { SessionPluginSlot } from "../../../src/renderer/components/session-plugin-slot";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

afterEach(cleanup);

const plugin = (id: string, title: string, sessionId = "session-1"): SessionPlugin => ({
  sessionId,
  id,
  title,
  slot: "composer.above",
  preset: "action-bar",
  state: { label: `${title} content`, actions: [{ id: "next", label: "Next", message: "Next" }] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function createAuthority() {
  let persisted: ApplicationStateValue = {
    ...defaultApplicationState(),
    sessionPlugins: [
      plugin("tour", "Tour"),
      plugin("neighbor", "Neighbor"),
      plugin("tour", "Other session tour", "session-2"),
      {
        sessionId: "session-1",
        id: "generated",
        title: "Custom controls",
        slot: "composer.above",
        source: "export default function Controls() { return null }",
        state: { current: 2 },
        hidden: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    sessionPluginSharedState: [{ sessionId: "session-1", key: "progress", value: { total: 4 } }],
  };
  let failSave = false;
  const storage = ApplicationStorage.of({
    load: Effect.fn("SessionPluginControls.Test.load")(() =>
      Effect.succeed({ state: structuredClone(persisted), source: "current" as const }),
    ),
    save: Effect.fn("SessionPluginControls.Test.save")(function* (state) {
      if (failSave)
        return yield* new ApplicationWriteError({ stage: "write", message: "Close failed" });
      persisted = structuredClone(state);
    }),
  });
  return {
    layer: ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage, storage))),
    persisted: () => persisted,
    failSave: (value: boolean) => {
      failSave = value;
    },
  };
}

async function renderPlugins(authority: ReturnType<typeof createAuthority>) {
  const runtime = ManagedRuntime.make(authority.layer);
  const state = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ApplicationState).initialize();
    }),
  );
  let revision = 0;
  const publish = (next: ApplicationStateValue) =>
    rootFixture.root.sessionPluginStore.applyApplicationState(++revision, next);
  const remove = vi.fn<Client["application"]["deleteSessionPlugin"]>(async (input) => {
    publish(await runtime.runPromise(deleteSessionPlugin(input.sessionId, input.pluginId)));
  });
  const setHidden = vi.fn<Client["application"]["setSessionPluginHidden"]>(async (input) => {
    publish(
      await runtime.runPromise(
        setSessionPluginHidden(input.sessionId, input.pluginId, input.hidden),
      ),
    );
  });
  const rootFixture = createRendererStoreFixture({
    client: { application: { deleteSessionPlugin: remove, setSessionPluginHidden: setHidden } },
  });
  publish(state);
  const headerClick = vi.fn();
  const view = render(
    <div onClick={headerClick}>
      <SessionPluginSlot
        sessionId="session-1"
        slot="composer.above"
        plugins={rootFixture.root.sessionPluginStore}
        inlineWidgets={rootFixture.root.inlineWidgetStore}
        call={async () => null}
      />
    </div>,
  );
  return {
    user: userEvent.setup(),
    remove,
    setHidden,
    headerClick,
    async [Symbol.asyncDispose]() {
      view.unmount();
      rootFixture[Symbol.dispose]();
      await runtime.dispose();
    },
  };
}

it.each(["session-1", CAKE_CHAT_SESSION_ID])(
  "plugin button sends in %s preserve the reading position and draft",
  async (sessionId) => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project" })],
      sessions: [sessionSummary({ sessionId: "session-1", projectPath: "/project" })],
      client: { sessionChats: { prompt } },
    });
    const session =
      sessionId === CAKE_CHAT_SESSION_ID
        ? fixture.root.cakeChatCollectionStore.registry.load(sessionId)
        : fixture.root.sessionRegistry.load(sessionId, "/project");
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId,
        sessionFile: "/project/session.jsonl",
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
    const chat = session.conversationSessionStore.chatStore;
    chat.setDraft("Keep my unfinished draft");
    const reveal = chat.transcriptInteraction.beginResultReveal();
    chat.transcriptInteraction.completeResultReveal(reveal, ["older-report"]);
    chat.transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    fixture.root.sessionPluginStore.applyApplicationState(1, {
      ...defaultApplicationState(),
      sessionPlugins: [plugin("tour", "Tour", sessionId)],
    });
    const view = render(
      <SessionPluginSlot
        sessionId={sessionId}
        slot="composer.above"
        plugins={fixture.root.sessionPluginStore}
        inlineWidgets={fixture.root.inlineWidgetStore}
        call={(pluginId, command, input) =>
          fixture.root.sessionPluginOperations.invoke(sessionId, pluginId, command, input)
        }
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(chat.transcriptInteraction.sentMessageRevision).toBe(1);
    expect(chat.transcriptInteraction.bottomRequestRevision).toBe(0);
    expect(chat.transcriptInteraction.transcriptScrollPosition).toEqual({ kind: "top" });
    expect(chat.transcriptInteraction.resultReveal).toBeUndefined();
    expect(chat.draft).toBe("Keep my unfinished draft");
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId, text: "Next", attachments: [] });
    view.unmount();
  },
);

it("keeps Hide/Show non-destructive and closes only the selected plugin durably", async () => {
  const authority = createAuthority();
  const initial = structuredClone(authority.persisted());
  {
    await using fixture = await renderPlugins(authority);
    await fixture.user.click(screen.getByRole("button", { name: "Hide Tour" }));
    expect(screen.queryByText("Tour content")).toBeNull();
    expect(screen.getByRole("button", { name: "Show Tour" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(authority.persisted().sessionPlugins).toHaveLength(4);
    expect(authority.persisted().sessionPlugins[0]).toEqual({
      ...initial.sessionPlugins[0],
      hidden: true,
    });
    expect(fixture.remove).not.toHaveBeenCalled();

    await fixture.user.click(screen.getByRole("button", { name: "Show Tour" }));
    expect(screen.getByText("Tour content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Tour" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(fixture.setHidden).toHaveBeenCalledTimes(2);

    await fixture.user.click(screen.getByRole("button", { name: "Close Tour" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Tour" })).toBeNull());
    expect(screen.getByText("Neighbor content")).toBeTruthy();
    expect(fixture.remove).toHaveBeenCalledExactlyOnceWith(
      { sessionId: "session-1", pluginId: "tour" },
      { signal: expect.any(AbortSignal) },
    );
    expect(fixture.setHidden).toHaveBeenCalledTimes(2);
    expect(fixture.headerClick).not.toHaveBeenCalled();
    expect(authority.persisted()).toEqual({
      ...initial,
      sessionPlugins: initial.sessionPlugins.slice(1),
    });
  }
  // Recreate both authority and renderer projection from the saved storage snapshot.
  {
    await using fixture = await renderPlugins(authority);
    expect(screen.queryByRole("button", { name: "Close Tour" })).toBeNull();
    expect(screen.getByText("Neighbor content")).toBeTruthy();
    expect(fixture.remove).not.toHaveBeenCalled();
  }
});

it("can close a hidden generated plugin and keeps it available for retry after a save failure", async () => {
  const authority = createAuthority();
  const initial = structuredClone(authority.persisted());
  await using fixture = await renderPlugins(authority);
  authority.failSave(true);
  await fixture.user.click(screen.getByRole("button", { name: "Close Custom controls" }));
  await waitFor(() => expect(screen.getByText("Close failed")).toBeTruthy());
  expect(authority.persisted()).toEqual(initial);
  expect(screen.getByRole("button", { name: "Show Custom controls" })).toHaveProperty(
    "disabled",
    false,
  );
  const close = screen.getByRole("button", { name: "Close Custom controls" });
  expect(close).toHaveProperty("disabled", false);

  authority.failSave(false);
  await fixture.user.click(close);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Custom controls" })).toBeNull());
  expect(authority.persisted()).toEqual({
    ...initial,
    sessionPlugins: initial.sessionPlugins.filter((entry) => entry.id !== "generated"),
  });
  expect(screen.getByText("Tour content")).toBeTruthy();
  expect(screen.getByText("Neighbor content")).toBeTruthy();
  expect(fixture.setHidden).not.toHaveBeenCalled();
  expect(fixture.headerClick).not.toHaveBeenCalled();
});
