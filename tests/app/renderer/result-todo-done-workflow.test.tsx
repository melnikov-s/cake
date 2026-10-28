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
import { Chat } from "../../../src/renderer/components/chat";
import { projectTranscriptBehaviorFor } from "../../../src/renderer/lib/project-transcript-behavior";
import { nestedTranscriptBehaviorFor } from "../../../src/renderer/lib/nested-transcript-behavior";
import { sessionSummary } from "./fixtures/catalog-fixtures";
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
  {
    id: "standalone-original",
    kind: "tool",
    name: "cake",
    command: "messages.present",
    input: "",
    state: "success",
    messageReference: `cake://session/${sessionA}?message=linked-original`,
  },
  {
    id: "different-source",
    kind: "text",
    role: "user",
    entryId: "different-source",
    text: "A different report from Benchmark.",
    status: "complete",
    crossSession: crossSession(sessionB, "Benchmark", "f6debbbd-ced1-4a12-b0f7-fb60c292c623"),
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
    client: {
      cakeChats: { open: async () => undefined },
      artifacts: { effective: async () => [] },
      projectTodos: { mutateUser },
    },
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
    root: fixture.root,
    models: fixture.models,
    view,
    kind,
    scope,
    chat,
    user,
    commit,
    mutateUser,
    items: { workerTodo, sessionTodo, sourceTodo },
    groupFor,
    /** The message control for one to-do, by its live title. */
    control: (title: string) => screen.getAllByRole("checkbox", { name: `Done: ${title}` }).at(-1)!,
    checked: (title: string) =>
      screen
        .getAllByRole("checkbox", { name: `Done: ${title}` })
        .at(-1)!
        .getAttribute("aria-checked"),
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
  "groups attributed follow-ups with one live rail label per switch and reveals without selecting context in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    const A = f.items.workerTodo.id;
    const B = f.items.sessionTodo.id;
    const attributed: UiPart[] = [A, A, B, A, null].flatMap((taskTodoId, index): UiPart[] => [
      {
        id: `u-${index}`,
        entryId: `u-${index}`,
        kind: "text",
        role: "user",
        text: `Question ${index}`,
        status: "complete",
        taskTodoId,
      },
      {
        id: `a-${index}`,
        entryId: `a-${index}`,
        kind: "text",
        role: "assistant",
        text: `Answer ${index}`,
        status: "complete",
      },
    ]);
    act(() =>
      applyConversationSnapshot(f.chat.model, {
        sessionId: f.chat.sessionId,
        sessionFile: "/chat.sqlite",
        parts: attributed,
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      }),
    );
    expect(screen.getAllByTitle("Show in To-do: Research options")).toHaveLength(2);
    expect(screen.getAllByTitle("Show in To-do: Fix the build")).toHaveLength(1);
    const messageCount = f.view.container.querySelectorAll("[data-part-id]").length;
    await f.user.click(screen.getAllByTitle("Show in To-do: Research options")[0]!);
    expect(screen.getByRole("complementary", { name: "To-do" })).toBeDefined();
    expect(f.mutateUser).not.toHaveBeenCalled();
    expect(f.chat.todos.selectedItem).toBeUndefined();
    const item = await f.read(A);
    await f.commit(
      projectTodos.update(f.scope, {
        id: A,
        expectedRevision: item.revision,
        title: "Startup findings",
        status: "Ready for review",
      }),
    );
    expect(screen.getAllByTitle("Show in To-do: Startup findings")).toHaveLength(2);
    expect(screen.getAllByText("Ready for review")).toHaveLength(2);
    await f.clickPane("Mark done", "Startup findings");
    expect(f.view.container.querySelectorAll("[data-part-id]")).toHaveLength(messageCount);
    expect(screen.getAllByTitle("Show in To-do: Startup findings")).toHaveLength(2);
  },
);

it.each(chats)(
  "groups consecutive incoming work by task and updates the existing rail after agent edits and session completion in %s",
  async (kind) => {
    await using f = await renderChat(kind);
    expect(screen.getAllByTitle("Show in To-do: Fix the build")).toHaveLength(1);
    expect(screen.getAllByTitle("Show in To-do: Research options")).toHaveLength(1);
    const count = f.view.container.querySelectorAll("[data-part-id]").length;
    await f.commit(
      projectTodos.update(f.scope, {
        id: f.items.workerTodo.id,
        expectedRevision: 0,
        title: "Research engine options",
        status: "Ready for review",
      }),
    );
    expect(screen.getByTitle("Show in To-do: Research engine options")).toBeDefined();
    await f.commit(projectTodos.completeResolved(f.scope, [f.items.sessionTodo]));
    expect((await f.read(f.items.sessionTodo.id)).completion?.by).toBe("sessions");
    expect(await f.paneState("Fix the build")).toBe("done");
    await f.clickPane("Reopen", "Fix the build");
    expect((await f.read(f.items.sessionTodo.id)).state).toBe("open");
    expect(screen.getAllByTitle("Show in To-do: Fix the build")).toHaveLength(1);
    expect(f.view.container.querySelectorAll("[data-part-id]")).toHaveLength(count);
  },
);

it("reuses the Project's to-do list for incoming Project Session and secondary-chat cards without opening Project Chat", async () => {
  await using f = await renderChat("Project Chat");
  f.view.unmount();
  act(() =>
    applySnapshot(f.models.sessionCatalog, {
      sessions: [
        sessionSummary({ sessionId: "viewer", projectPath, workingDirectory: projectPath }),
      ],
      resolvedHasMoreByProject: {},
    }),
  );
  const session = f.root.sessionRegistry.load("viewer", projectPath);
  act(() =>
    applyConversationSnapshot(session.model, {
      sessionId: "viewer",
      sessionFile: "/viewer.jsonl",
      parts: parts.filter((part) => part.kind === "text" && part.crossSession),
      models: [],
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    }),
  );
  session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
    kind: "top",
  });
  const behavior = projectTranscriptBehaviorFor(f.root, session);
  expect(behavior.todos).toBe(f.chat.todos);
  expect(
    nestedTranscriptBehaviorFor(f.root, session.conversationSessionStore.chatStore, behavior).todos,
  ).toBe(f.chat.todos);
  const view = render(
    <StoreProvider store={f.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 4000, itemHeight: 100 }}>
        <Chat
          store={session.conversationSessionStore.chatStore}
          transcriptBehavior={behavior}
          composerFocusEnabled={false}
        />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  expect(screen.getAllByRole("checkbox", { name: "Done: Fix the build" })).toHaveLength(3);
  await f.user.click(screen.getAllByRole("checkbox", { name: "Done: Fix the build" })[0]!);
  expect((await f.read(f.items.sessionTodo.id)).state).toBe("done");
  expect(
    screen
      .getAllByRole("checkbox", { name: "Done: Fix the build" })
      .every((control) => control.getAttribute("aria-checked") === "true"),
  ).toBe(true);
  view.unmount();
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
