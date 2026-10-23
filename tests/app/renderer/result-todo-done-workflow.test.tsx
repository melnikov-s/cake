/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  type ProjectTodo,
  type ProjectTodos,
} from "../../../src/contracts/projects/project-todos";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyCakeChatTodosProjection } from "../../../src/renderer/reducers/CakeChatTodosReducer";
import { researchOrigin } from "../../fixtures/subagent-report";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const worker = "10000000-0000-4000-8000-0000000000a1";
const unlinkedWorker = "10000000-0000-4000-8000-0000000000a2";
const sessionA = "20000000-0000-4000-8000-0000000000b1";
const sessionB = "20000000-0000-4000-8000-0000000000b2";
const unlinkedSession = "20000000-0000-4000-8000-0000000000b3";

const todo = (id: string, title: string, associations: ProjectTodo["associations"]) => ({
  id,
  title,
  description: `${title}.`,
  status: "Report delivered; awaiting your review",
  state: "open" as const,
  revision: 0,
  associations,
});
const workerTodo = todo("00000000-0000-4000-8000-000000000001", "Research options", [
  { kind: "subagent", parentSessionId: CAKE_CHAT_SESSION_ID, handleId: worker, title: "Worker" },
]);
const sessionTodo = todo("00000000-0000-4000-8000-000000000002", "Fix the build", [
  { kind: "session", sessionId: sessionA, title: "Build fix" },
]);
const sourceTodo = todo("00000000-0000-4000-8000-000000000003", "Benchmark startup", [
  { kind: "source", ref: `cake://session/${sessionB}?message=final`, title: "Findings" },
]);

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

function renderGlobalChat() {
  let revision = 1;
  // Fresh copies: snapshot application reconciles projected items in place.
  let todos: ProjectTodos = {
    ...emptyProjectTodos(),
    items: structuredClone([workerTodo, sessionTodo, sourceTodo]),
  };
  const project = () =>
    applyCakeChatTodosProjection(fixture.models.cakeChatTodos, {
      revision: revision++,
      state: { ...defaultApplicationState(), cakeChatTodos: todos },
    });
  const mutateUser = vi.fn<Client["projectTodos"]["mutateUser"]>(async ({ scope, mutation }) => {
    if (scope !== CAKE_CHAT_TODO_SCOPE || mutation._tag !== "SetState")
      throw new Error("Unexpected to-do mutation");
    const item = todos.items.find((candidate) => candidate.id === mutation.id);
    if (!item || item.revision !== mutation.expectedRevision) throw new Error("Stale revision");
    todos = {
      ...todos,
      items: todos.items.map((candidate) =>
        candidate.id === mutation.id
          ? {
              ...candidate,
              state: mutation.state,
              revision: candidate.revision + 1,
              ...(mutation.state === "done"
                ? { completion: { revision: candidate.revision + 1, by: "user" as const } }
                : { completion: undefined }),
            }
          : candidate,
      ),
    };
    act(project);
    return todos;
  });
  const fixture = createRendererStoreFixture({
    client: { artifacts: { effective: async () => [] }, projectTodos: { mutateUser } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  act(() => {
    project();
    fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
    fixture.root.cakeChatCollectionStore.sessionLayoutStore.showSession(CAKE_CHAT_SESSION_ID);
    fixture.root.navigationStore.selectCakeChat(CAKE_CHAT_SESSION_ID);
    applyConversationSnapshot(chat.model, {
      sessionId: CAKE_CHAT_SESSION_ID,
      sessionFile: "/cake-chat.sqlite",
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
  return {
    user: userEvent.setup(),
    mutateUser,
    ready: () =>
      waitFor(() => expect(view.container.querySelector('[data-part-id="notice"]')).not.toBeNull()),
    chat,
    container: view.container,
    groupFor: (partId: string) =>
      view.container
        .querySelector(`[data-part-id="${partId}"]`)
        ?.querySelector('[data-slot="result-todo-done"]') ?? null,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("offers Done only on result messages linked to an open to-do in global Cake Chat", async () => {
  using f = renderGlobalChat();
  await f.ready();
  expect(f.groupFor("worker-report")?.textContent).toBe("To-do · Research optionsMark done");
  expect(f.groupFor("session-reply")?.textContent).toBe("To-do · Fix the buildMark done");
  expect(f.groupFor("notice")?.textContent).toBe("To-do · Benchmark startupMark done");
  // Unlinked results and a linked session's request are not results to close.
  expect(f.groupFor("unlinked-report")).toBeNull();
  expect(f.groupFor("session-request")).toBeNull();
  expect(screen.getAllByRole("group", { name: "Linked to-dos" })).toHaveLength(3);
  // The bar is part of each message, so every result type shares one layout.
  expect(f.groupFor("worker-report")?.closest('[data-slot="message-content"]')).not.toBeNull();
  expect(f.groupFor("session-reply")?.closest('[data-slot="session-message"]')).not.toBeNull();
  expect(f.groupFor("notice")?.closest('[aria-label="Session results"]')).not.toBeNull();
});

it("marks the linked to-do done through the user path, shows it done and can reopen it", async () => {
  using f = renderGlobalChat();
  await f.ready();
  await f.user.click(screen.getByRole("button", { name: "Mark to-do done: Fix the build" }));
  expect(f.mutateUser).toHaveBeenCalledWith(
    {
      scope: CAKE_CHAT_TODO_SCOPE,
      mutation: { _tag: "SetState", id: sessionTodo.id, expectedRevision: 0, state: "done" },
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  const done = screen.getByRole("button", { name: "Reopen to-do: Fix the build" });
  expect(done.getAttribute("aria-pressed")).toBe("true");
  expect(f.chat.todos.openItems.map((item) => item.title)).toEqual([
    "Research options",
    "Benchmark startup",
  ]);
  await f.user.click(done);
  expect(f.mutateUser).toHaveBeenLastCalledWith(
    {
      scope: CAKE_CHAT_TODO_SCOPE,
      mutation: { _tag: "SetState", id: sessionTodo.id, expectedRevision: 1, state: "open" },
    },
    expect.anything(),
  );
  expect(
    screen
      .getByRole("button", { name: "Mark to-do done: Fix the build" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

it("hides the control once an agent or session resolution closed the to-do", async () => {
  using f = renderGlobalChat();
  await f.ready();
  act(() =>
    applyCakeChatTodosProjection(f.chat.props.cakeChatTodos!()!, {
      revision: 100,
      state: {
        ...defaultApplicationState(),
        cakeChatTodos: {
          ...emptyProjectTodos(),
          items: structuredClone([
            { ...workerTodo, state: "done", revision: 1, completion: { revision: 1, by: "agent" } },
            {
              ...sessionTodo,
              state: "done",
              revision: 1,
              completion: { revision: 1, by: "sessions" },
            },
            sourceTodo,
          ]),
        },
      },
    }),
  );
  expect(f.groupFor("worker-report")).toBeNull();
  expect(f.groupFor("session-reply")).toBeNull();
  expect(f.groupFor("notice")?.textContent).toBe("To-do · Benchmark startupMark done");
});

it("gives global Cake Chat its own To-do pane", async () => {
  using f = renderGlobalChat();
  await f.ready();
  await f.user.click(screen.getByRole("button", { name: "To-do" }));
  const open = await screen.findByRole("list", { name: "Open to-dos" });
  expect(
    within(open)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Mark done: ")),
  ).toEqual([
    "Mark done: Research options",
    "Mark done: Fix the build",
    "Mark done: Benchmark startup",
  ]);
  // Closing from the pane removes the message control's open state too: one shared authority.
  await f.user.click(
    within(open)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-label") === "Mark done: Research options")!,
  );
  expect(
    screen
      .getByRole("button", { name: "Reopen to-do: Research options" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(f.chat.todos.source?.chat).toBe("Cake Chat");
});

it("opens global Cake Chat's To-do pane when its first item arrives, not on hydration", () => {
  using fixture = createRendererStoreFixture({});
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  const chat = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
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
  project(1, [sourceTodo]);
  expect(chat.todos.visible).toBe(false);
  project(2, []);
  project(3, [workerTodo]);
  expect(chat.todos.visible).toBe(true);
  project(3, [workerTodo, sessionTodo]); // Stale revisions are ignored.
  expect(chat.todos.openItems.map((item) => item.title)).toEqual(["Research options"]);
});
