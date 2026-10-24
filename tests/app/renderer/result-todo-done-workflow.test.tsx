/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  type ProjectTodo,
  type ProjectTodoCreate,
} from "../../../src/contracts/projects/project-todos";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { upsertProject } from "../../../src/domain/application/application";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyCakeChatTodosProjection } from "../../../src/renderer/reducers/CakeChatTodosReducer";
import { applyProjectCatalogUpdate } from "../../../src/renderer/reducers/CatalogReducer";
import { researchOrigin } from "../../fixtures/subagent-report";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const worker = "10000000-0000-4000-8000-0000000000a1";
const unlinkedWorker = "10000000-0000-4000-8000-0000000000a2";
const sessionA = "20000000-0000-4000-8000-0000000000b1";
const sessionB = "20000000-0000-4000-8000-0000000000b2";
const unlinkedSession = "20000000-0000-4000-8000-0000000000b3";
const projectPath = "/zombies";
const projectChatId = `project-chat:${"a".repeat(64)}`;

type ChatKind = "Cake Chat" | "Project Chat";
const chats: readonly ChatKind[] = ["Cake Chat", "Project Chat"];

const crossSession = (sessionId: string, title: string, replyTo?: string) => ({
  version: 1 as const,
  messageId: crypto.randomUUID(),
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 2,
  expectsResponse: false,
  ...(replyTo ? { replyToMessageId: replyTo } : null),
  sender: { sessionId, title, kind: "project-session" as const },
});
const parts: UiPart[] = [
  {
    id: "worker-report",
    kind: "text",
    role: "user",
    entryId: "worker-report",
    text: "Option B is fastest.",
    status: "complete",
    subagentReport: { ...researchOrigin, handleId: worker },
  },
  {
    id: "unlinked-report",
    kind: "text",
    role: "user",
    entryId: "unlinked-report",
    text: "Nothing tracks this report.",
    status: "complete",
    subagentReport: { ...researchOrigin, handleId: unlinkedWorker },
  },
  {
    id: "session-progress",
    kind: "text",
    role: "user",
    entryId: "session-progress",
    text: "Halfway there: the port wait is in, CI is still running.",
    status: "complete",
    renderAs: "markdown",
    crossSession: crossSession(sessionA, "Build fix", "f6debbbd-ced1-4a12-b0f7-fb60c292c623"),
  },
  {
    id: "session-reply",
    kind: "text",
    role: "user",
    entryId: "session-reply",
    text: "The build is fixed.",
    status: "complete",
    renderAs: "markdown",
    crossSession: crossSession(sessionA, "Build fix", "f6debbbd-ced1-4a12-b0f7-fb60c292c623"),
  },
  {
    id: "session-request",
    kind: "text",
    role: "user",
    entryId: "session-request",
    text: "Which branch should I use?",
    status: "complete",
    renderAs: "markdown",
    crossSession: { ...crossSession(sessionA, "Build fix"), expectsResponse: true },
  },
  {
    id: "notice",
    kind: "context",
    title: "Session updates",
    text: [
      "<system-reminder>",
      "Cake session updates",
      `- [Full agent response — Benchmark](cake://session/${sessionB}?message=final) (b2) finished`,
      `- [Other](cake://session/${unlinkedSession}) finished`,
      "</system-reminder>",
    ].join("\n"),
  },
];

function createTodoRuntime() {
  return ManagedRuntime.make(
    ApplicationState.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ApplicationStorage,
          ApplicationStorage.of({
            load: () => Effect.succeed({ state: defaultApplicationState(), source: "current" }),
            save: () => Effect.void,
          }),
        ),
      ),
    ),
  );
}

/**
 * One chat over the real main-owned to-do authority. Every domain change (user mutation, agent
 * tool or automatic completion) reaches the window only as an application projection, as in
 * the app, so the pane and the message control can only agree through the shared list.
 */
async function renderChat(kind: ChatKind) {
  const runtime = createTodoRuntime();
  const chatId = kind === "Cake Chat" ? CAKE_CHAT_SESSION_ID : projectChatId;
  const scope = kind === "Cake Chat" ? CAKE_CHAT_TODO_SCOPE : projectPath;
  await runtime.runPromise(upsertProject(projectPath, "zombies"));
  const create = (request: ProjectTodoCreate) =>
    runtime.runPromise(projectTodos.create(scope, { status: "Awaiting your review", ...request }));
  const workerTodo = await create({
    title: "Research options",
    description: "Research options.",
    associations: [
      { kind: "subagent", parentSessionId: chatId, handleId: worker, title: "Worker" },
    ],
  });
  const sessionTodo = await create({
    title: "Fix the build",
    description: "Fix the build.",
    associations: [{ kind: "session", sessionId: sessionA, title: "Build fix" }],
  });
  const sourceTodo = await create({
    title: "Benchmark startup",
    description: "Benchmark startup.",
    associations: [
      { kind: "source", ref: `cake://session/${sessionB}?message=final`, title: "Findings" },
    ],
  });

  let revision = 0;
  const state = () => runtime.runPromise(Effect.map(ApplicationState, (value) => value.snapshot()));
  const project = (value: ApplicationStateValue) => {
    revision += 1;
    applyCakeChatTodosProjection(fixture.models.cakeChatTodos, { revision, state: value });
    applyProjectCatalogUpdate(fixture.models.projects, {
      _tag: "Snapshot",
      revision,
      projects: value.projects,
    });
  };
  /** Commit through the domain, then publish the application projection to the window. */
  const commit = async <A,>(effect: Effect.Effect<A, unknown, ApplicationState>) => {
    const value = await runtime.runPromise(effect);
    const next = await state();
    act(() => project(next));
    return value;
  };
  const mutateUser = vi.fn<Client["projectTodos"]["mutateUser"]>(({ scope, mutation }) =>
    commit(projectTodos.mutateUser(scope, mutation)),
  );
  const fixture = createRendererStoreFixture({
    client: { artifacts: { effective: async () => [] }, projectTodos: { mutateUser } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [
      kind === "Cake Chat"
        ? { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }
        : { sessionId: projectChatId, title: "zombies", projectPath },
    ],
  });
  const initial = await state();
  const chat = fixture.root.cakeChatCollectionStore.registry.load(chatId);
  act(() => {
    project(initial);
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(chatId);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(chatId);
    fixture.root.navigationStore.selectCakeChat(chatId);
    applyConversationSnapshot(chat.model, {
      sessionId: chatId,
      sessionFile: "/chat.sqlite",
      parts,
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    });
    chat.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  });
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 4000, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-part-id="notice"]')).not.toBeNull(),
  );
  const user = userEvent.setup();
  const groupFor = (partId: string) =>
    view.container
      .querySelector(`[data-part-id="${partId}"]`)
      ?.querySelector('[data-slot="result-todo-done"]') ?? null;
  const pane = async () => {
    const open = screen.queryByRole("complementary", { name: "To-do" });
    if (open) return open;
    await user.click(screen.getByRole("button", { name: "To-do" }));
    return screen.getByRole("complementary", { name: "To-do" });
  };
  return {
    kind,
    scope,
    chat,
    user,
    commit,
    mutateUser,
    items: { workerTodo, sessionTodo, sourceTodo },
    groupFor,
    /** The message control for one to-do, by its live title. */
    control: (title: string) => screen.getByRole("checkbox", { name: `Done: ${title}` }),
    checked: (title: string) =>
      screen.getByRole("checkbox", { name: `Done: ${title}` }).getAttribute("aria-checked"),
    read: (id: string) => runtime.runPromise(projectTodos.read(scope, id)),
    list: () => runtime.runPromise(projectTodos.list(scope)),
    /** The pane's own open/done rows, expanding Done history when needed. */
    async paneState(title: string) {
      const panel = await pane();
      const done = within(panel).queryByRole("button", { name: /^Done \(\d+\)$/ });
      if (done?.getAttribute("aria-expanded") === "false") await user.click(done);
      if (within(panel).queryByRole("button", { name: `Mark done: ${title}` })) return "open";
      if (within(panel).queryByRole("button", { name: `Reopen: ${title}` })) return "done";
      return "absent";
    },
    async clickPane(action: "Mark done" | "Reopen", title: string) {
      const panel = await pane();
      const done = within(panel).queryByRole("button", { name: /^Done \(\d+\)$/ });
      if (done?.getAttribute("aria-expanded") === "false") await user.click(done);
      await user.click(within(panel).getByRole("button", { name: `${action}: ${title}` }));
    },
    async [Symbol.asyncDispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
      await runtime.dispose();
    },
  };
}

it.each(chats)(
  "places one live control on each linked result message's latest result in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    expect(f.groupFor("worker-report")?.textContent).toBe("To-do · Research optionsDone");
    expect(f.groupFor("session-reply")?.textContent).toBe("To-do · Fix the buildDone");
    for (const title of ["Research options", "Fix the build"])
      expect(f.checked(title)).toBe("false");
    // Only the latest result from a linked session carries its control.
    expect(f.groupFor("session-progress")).toBeNull();
    // Unlinked results and a linked session's request are not results to close.
    expect(f.groupFor("unlinked-report")).toBeNull();
    expect(f.groupFor("session-request")).toBeNull();
    expect(screen.getAllByRole("group", { name: "Linked to-dos" })).toHaveLength(2);
    // The bar is part of each message, so every result type shares one layout.
    expect(f.groupFor("worker-report")?.closest('[data-slot="message-content"]')).not.toBeNull();
    expect(f.groupFor("session-reply")?.closest('[data-slot="session-message"]')).not.toBeNull();
    expect(await f.paneState("Benchmark startup")).toBe("open");
    expect(f.chat.todos.source?.chat).toBe(kind);
  },
);

it.each(chats)(
  "shows a pane Done on the message, and a message reopen in the pane, in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    await f.clickPane("Mark done", "Fix the build");
    expect(f.checked("Fix the build")).toBe("true");
    expect(await f.paneState("Fix the build")).toBe("done");

    await f.user.click(f.control("Fix the build"));
    expect(f.checked("Fix the build")).toBe("false");
    expect(await f.paneState("Fix the build")).toBe("open");
    expect((await f.read(f.items.sessionTodo.id)).state).toBe("open");
  },
);

it.each(chats)(
  "shows a message Done in the pane, and a pane reopen on the message, in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    await f.user.click(f.control("Research options"));
    // The same user done/reopen path as the pane, reported with the next user message.
    expect(f.mutateUser).toHaveBeenCalledWith(
      {
        scope: f.scope,
        mutation: {
          _tag: "SetState",
          id: f.items.workerTodo.id,
          expectedRevision: 0,
          state: "done",
        },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect((await f.list()).pending).toContainEqual(
      expect.objectContaining({ _tag: "ItemState", id: f.items.workerTodo.id, state: "done" }),
    );
    expect(f.checked("Research options")).toBe("true");
    expect(await f.paneState("Research options")).toBe("done");

    await f.clickPane("Reopen", "Research options");
    expect(f.checked("Research options")).toBe("false");
    expect(await f.paneState("Research options")).toBe("open");
  },
);

it.each(chats)(
  "follows agent tool edits and automatic completion live on the message in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    const { workerTodo, sessionTodo, sourceTodo } = f.items;
    // todos.update: an agent rename and closure.
    await f.commit(
      projectTodos.update(f.scope, {
        id: workerTodo.id,
        expectedRevision: 0,
        title: "Research engine options",
      }),
    );
    expect(f.groupFor("worker-report")?.textContent).toBe("To-do · Research engine optionsDone");
    expect(screen.queryByRole("checkbox", { name: "Done: Research options" })).toBeNull();
    await f.commit(
      projectTodos.update(f.scope, { id: workerTodo.id, expectedRevision: 1, state: "done" }),
    );
    expect(f.checked("Research engine options")).toBe("true");

    // Automatic completion when the linked session resolves.
    await f.commit(projectTodos.completeResolved(f.scope, [sessionTodo]));
    expect((await f.read(sessionTodo.id)).completion?.by).toBe("sessions");
    expect(f.checked("Fix the build")).toBe("true");
    expect(await f.paneState("Fix the build")).toBe("done");

    // todos.update-many: close one and reopen another in one batch.
    await f.commit(
      projectTodos.updateMany(f.scope, [
        { id: sourceTodo.id, expectedRevision: 0, state: "done" },
        { id: sessionTodo.id, expectedRevision: 1, state: "open" },
      ]),
    );
    expect(await f.paneState("Benchmark startup")).toBe("done");
    expect(f.checked("Fix the build")).toBe("false");

    // The user can still reopen an agent closure from the message.
    await f.user.click(f.control("Research engine options"));
    expect(f.checked("Research engine options")).toBe("false");
    expect(await f.paneState("Research engine options")).toBe("open");
  },
);

it.each(chats)("removes the control when its to-do leaves the list in %s", async (kind) => {
  await using f = await renderChat(kind);
  const { sessionTodo } = f.items;
  await f.commit(
    Effect.flatMap(ApplicationState, (application) =>
      application.transact((current) =>
        Effect.succeed(
          kind === "Cake Chat"
            ? {
                ...current,
                cakeChatTodos: {
                  ...current.cakeChatTodos!,
                  items: current.cakeChatTodos!.items.filter(
                    (item: ProjectTodo) => item.id !== sessionTodo.id,
                  ),
                },
              }
            : {
                ...current,
                projects: current.projects.map((project) => ({
                  ...project,
                  todos: {
                    ...project.todos!,
                    items: project.todos!.items.filter((item) => item.id !== sessionTodo.id),
                  },
                })),
              },
        ),
      ),
    ),
  );
  expect(f.groupFor("session-reply")).toBeNull();
  // An earlier result does not inherit a vanished to-do's control either.
  expect(f.groupFor("session-progress")).toBeNull();
  expect(f.checked("Research options")).toBe("false");
});

it("removes Project Chat controls when the list itself is unavailable", async () => {
  await using f = await renderChat("Project Chat");
  await f.commit(
    Effect.flatMap(ApplicationState, (application) =>
      application.transact((current) => Effect.succeed({ ...current, projects: [] })),
    ),
  );
  expect(f.chat.todos.available).toBe(false);
  expect(screen.queryAllByRole("group", { name: "Linked to-dos" })).toHaveLength(0);
});

it("opens global Cake Chat's To-do pane when its first item arrives, not on hydration", () => {
  using fixture = createRendererStoreFixture({});
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const item = (id: string, title: string): ProjectTodo => ({
    id,
    title,
    description: `${title}.`,
    status: "",
    state: "open",
    revision: 0,
    associations: [],
  });
  const project = (revision: number, items: ProjectTodo[]) =>
    act(() =>
      applyCakeChatTodosProjection(fixture.models.cakeChatTodos, {
        revision,
        state: {
          ...defaultApplicationState(),
          cakeChatTodos: { ...emptyProjectTodos(), items: structuredClone(items) },
        },
      }),
    );
  const first = item("00000000-0000-4000-8000-000000000001", "Research options");
  const second = item("00000000-0000-4000-8000-000000000002", "Fix the build");
  project(1, [second]);
  expect(chat.todos.visible).toBe(false);
  project(2, []);
  project(3, [first]);
  expect(chat.todos.visible).toBe(true);
  project(3, [first, second]); // Stale revisions are ignored.
  expect(chat.todos.openItems.map((candidate) => candidate.title)).toEqual(["Research options"]);
});
