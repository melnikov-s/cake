import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../../src/domain/cake-chats/cakeChatLocations";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
  LiveDoc,
} from "@earendil-works/pi-durable";
import {
  Type,
  createAssistantMessageEventStream,
  type Context,
  type AssistantMessage,
} from "@earendil-works/pi-durable-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import {
  prepareTaskAttribution,
  TaskAttributionDoc,
  TASK_ATTRIBUTION_INSTRUCTIONS,
} from "../../../../src/services/pi-durable/durable-task-attribution";
import { taskAttributionOperations } from "../../../../src/services/pi-durable/durable-task-attribution-operations";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import type { ProjectTodo } from "../../../../src/contracts/projects/project-todos";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const todo = (id: string): ProjectTodo => ({
  id,
  title: id === A ? "Startup investigation" : "Improve navigation",
  description: "Current work",
  status: "Investigating",
  state: "open",
  revision: 0,
  associations: [],
});
const turnIds = (request: Context) =>
  request.messages
    .flatMap((message) =>
      message.role !== "user"
        ? []
        : typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .flatMap((text) => [...text.matchAll(/<cake-turn id="([^"]+)"\/>/g)].map((match) => match[1]));
const metadata = (turnId: string, todoId: string | null) =>
  `<cake-todo>${JSON.stringify({ turnId, todoId })}</cake-todo>`;

async function fixture(database?: string) {
  let decision: string | null | undefined = A;
  let response: ((request: Context, index: number) => AssistantMessage) | undefined;
  let items = [todo(A), todo(B)];
  const f = durableModels(
    (request, index) =>
      response?.(request, index) ??
      durableAnswer(
        (decision === undefined ? "" : metadata(turnIds(request).at(-1)!, decision)) +
          "Normal streamed answer",
      ),
  );
  const classify = vi.spyOn(f.models, "completeSimple");
  const registry = createRegistry();
  const tool = defineTool({
    name: "create_task",
    description: "Create task",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      items.push(todo(B));
      return { output: [{ type: "text", text: JSON.stringify(todo(B)) }] };
    },
  });
  registry.install(defineExtension({ name: "test", tools: [tool] }));
  const engine = await openDurableChatEngine({
    storage: database ? await openNodeSqliteStorage(database) : new MemoryStorage(),
    models: f.models,
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      tools: [tool],
      instructions: TASK_ATTRIBUTION_INSTRUCTIONS,
    },
    memory: { budget: () => 4000, summarize: async () => "memory" },
    todos: () => items,
    onChanged: vi.fn(),
    onReport: vi.fn(),
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await engine.close();
    }
  };
  cleanup.push(close);
  const submit = (
    text: string,
    conversation = engine.root,
    delivery: "steer" | "followUp" = "followUp",
  ) =>
    conversation.submit(
      {
        type: "input",
        content: durableInputText(
          text,
          [],
          false,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          conversation.id,
        ),
        whenBusy: delivery,
      },
      context,
    );
  const send = async (text: string, conversation = engine.root) => {
    const s = await submit(text, conversation);
    const result = await s.wait(context);
    if (result.status !== "done" || result.type !== "input")
      throw new Error("Main response failed");
    return result;
  };
  const doc = (conversation = engine.root) =>
    engine.harness.snapshot(TaskAttributionDoc, conversation.id, context);
  const page = async (conversation = engine.root) =>
    readDurableOriginalPage(
      conversation,
      undefined,
      undefined,
      undefined,
      undefined,
      (await doc(conversation))?.inputs,
    );
  const hold = () => {
    const stream = createAssistantMessageEventStream();
    let ready!: (request: Context) => void;
    const started = new Promise<Context>((resolve) => {
      ready = resolve;
    });
    vi.mocked(f.models.streamSimple).mockImplementationOnce((_model, request) => {
      f.requests.push(structuredClone(request));
      ready(request);
      return stream;
    });
    return {
      started,
      stream,
      finish: (request: Context, id: string | null = A) => {
        const message = durableAnswer(metadata(turnIds(request).at(-1)!, id) + "Held answer");
        stream.push({ type: "done", reason: "stop", message });
      },
    };
  };
  return {
    ...f,
    engine,
    classify,
    submit,
    send,
    doc,
    page,
    hold,
    close,
    setDecision: (id: string | null | undefined) => {
      decision = id;
    },
    setResponse: (fn: typeof response) => {
      response = fn;
    },
    setTodos: (todos: ProjectTodo[]) => {
      items = todos;
    },
  };
}

it("uses only the normal conversation request for continuation, switch, explicit none and return, without metadata in prose", async () => {
  const f = await fixture();
  const decisions = [A, A, B, null, A];
  const entries = [];
  for (const [i, id] of decisions.entries()) {
    f.setDecision(id);
    entries.push(
      String(
        (
          await f.send(
            ["Startup", "Check config too", "Navigation instead", "Weather?", "Back to startup"][
              i
            ]!,
          )
        ).entry,
      ),
    );
  }
  const doc = await f.doc();
  expect(entries.map((entry) => doc?.inputs[entry])).toEqual(
    decisions.map((todoId) => ({ pending: false, todoId, turnId: expect.any(String) })),
  );
  const page = await f.page();
  expect(
    page.parts
      .filter((part) => part.kind === "text" && part.role === "user")
      .map((part) => (part.kind === "text" ? part.taskTodoId : undefined)),
  ).toEqual(decisions);
  expect(JSON.stringify(page.parts)).not.toContain("cake-todo");
  expect(JSON.stringify(page.parts)).not.toContain("cake-turn");
  expect(f.requests).toHaveLength(5);
  expect(f.classify).not.toHaveBeenCalled();
  const tasks = await f.engine.root.commit(
    (tx) => tx.scanTasks({ conversationId: f.engine.root.id, kind: "cake.task-attribution" }, 100),
    context,
  );
  expect(tasks.items).toEqual([]);
  // Earlier inputs are byte-identical across subsequent requests; no replayed classifier payload.
  expect(f.requests[1]?.messages.find((message) => message.role === "user")).toEqual(
    f.requests[0]?.messages.find((message) => message.role === "user"),
  );
});

it("publishes follow-up, switch, none and return associations from the live stream before prose or completion", async () => {
  const f = await fixture();
  const decisions = [A, A, B, null, A];
  for (const [index, decision] of decisions.entries()) {
    const held = f.hold();
    const submission = await f.submit(
      ["Startup", "Check config too", "Navigation", "Weather?", "Back to startup"][index]!,
    );
    const request = await held.started;
    let unsubscribe = () => {};
    const settled = new Promise<void>((resolve) => {
      unsubscribe = f.engine.harness.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === "document" && change.record.kind === "cake.task-attribution",
          )
        )
          resolve();
      });
    });
    const text = metadata(turnIds(request).at(-1)!, decision);
    held.stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: durableAnswer(text),
    });
    await settled;
    unsubscribe();
    expect(
      (await f.page()).parts.findLast((part) => part.kind === "text" && part.role === "user"),
    ).toMatchObject({ taskTodoId: decision });
    held.finish(request, decision);
    await submission.wait(context);
  }
  expect(f.requests).toHaveLength(5);
  expect(f.classify).not.toHaveBeenCalled();
});

it("projects a newly admitted input pending while an old group exists, even before request preparation, then settles it", async () => {
  const f = await fixture();
  await f.send("Startup");
  const held = f.hold();
  const s = await f.submit("Navigation instead");
  const request = await held.started;
  const doc = await f.doc();
  const pending = Object.values(doc?.inputs ?? {}).find((value) => value.pending);
  expect(pending).toMatchObject({ pending: true, todoId: null });
  const parts = (await f.page()).parts;
  expect(parts.findLast((part) => part.kind === "text" && part.role === "user")).toMatchObject({
    taskAttributionPending: true,
  });
  // Projection defaults a token-bearing new turn to unresolved even if its doc write has not happened.
  const before = await readDurableOriginalPage(f.engine.root);
  expect(
    before.parts.findLast((part) => part.kind === "text" && part.role === "user"),
  ).toMatchObject({ taskAttributionPending: true });
  held.finish(request, B);
  await s.wait(context);
  expect(
    (await f.page()).parts.findLast((part) => part.kind === "text" && part.role === "user"),
  ).toMatchObject({ taskTodoId: B });
});

it("supports a new to-do created mid-response without an attribution-only model/tool round", async () => {
  const f = await fixture();
  f.setTodos([todo(A)]);
  f.setResponse((request, index) =>
    index === 1
      ? durableAnswer("", [{ type: "toolCall", id: "create", name: "create_task", arguments: {} }])
      : durableAnswer(metadata(turnIds(request).at(-1)!, B) + "Created navigation"),
  );
  const sent = await f.send("Create navigation work");
  expect((await f.doc())?.inputs[String(sent.entry)]).toMatchObject({ pending: false, todoId: B });
  expect(f.requests).toHaveLength(2);
  expect(f.classify).not.toHaveBeenCalled();
});

it.each(["invalid", "unknown", "completed", "missing", "duplicate"])(
  "keeps %s decisions unresolved rather than inheriting or claiming explicit none",
  async (mode) => {
    const f = await fixture();
    await f.send("Startup");
    if (mode === "completed") f.setTodos([todo(A), { ...todo(B), state: "done" }]);
    f.setResponse((request) => {
      const id = turnIds(request).at(-1)!;
      const block =
        mode === "invalid"
          ? '<cake-todo>{"turnId":"bad","todoId":null}</cake-todo>'
          : mode === "missing"
            ? ""
            : metadata(id, mode === "unknown" ? "00000000-0000-4000-8000-000000000099" : B);
      const answer = durableAnswer(
        block + (mode === "duplicate" ? metadata(id, A) : "") + "Other subject",
      );
      return answer;
    });
    const sent = await f.submit("Other subject");
    await sent.wait(context);
    const user = (await f.page()).parts.findLast(
      (part) => part.kind === "text" && part.role === "user",
    );
    expect(user).toMatchObject({ taskAttributionPending: true });
    expect(user).not.toHaveProperty("taskTodoId");
    expect(JSON.stringify((await f.page()).parts)).not.toContain("cake-todo");
  },
);

it("never applies an earlier decision to a queued or later input, and ignores repeated old IDs", async () => {
  const f = await fixture();
  const held = f.hold();
  const first = await f.submit("Startup");
  const request = await held.started;
  const oldId = turnIds(request).at(-1)!;
  const second = await f.submit("Navigation queued");
  f.setResponse((req) =>
    durableAnswer(metadata(oldId, A) + metadata(turnIds(req).at(-1)!, B) + "Navigation"),
  );
  held.finish(request, A);
  await first.wait(context);
  await second.wait(context);
  expect(
    (await f.page()).parts
      .filter((part) => part.kind === "text" && part.role === "user")
      .map((part) => (part.kind === "text" ? part.taskTodoId : undefined)),
  ).toEqual([A, B]);
  f.setResponse(() => durableAnswer("Stale" + metadata(oldId, B)));
  const last = await f.send("Unassigned new input");
  expect((await f.doc())?.inputs[String(last.entry)]).toMatchObject({ pending: true });
});

it("binds overlapping steered input decisions individually, never promoting an older result", async () => {
  const f = await fixture();
  const held = f.hold();
  const first = await f.submit("Startup");
  const request = await held.started;
  const oldId = turnIds(request).at(-1)!;
  const second = await f.submit("Switch now", f.engine.root, "steer");
  f.setResponse((req) =>
    durableAnswer(metadata(oldId, B) + metadata(turnIds(req).at(-1)!, B) + "Switched"),
  );
  held.finish(request, A);
  await first.wait(context);
  await second.wait(context);
  const inputs = Object.values((await f.doc())?.inputs ?? {});
  expect(inputs[0]).toMatchObject({ todoId: A });
  expect(inputs[1]).toMatchObject({ todoId: B });
});

it("keeps unresolved and settled decisions and manual corrections across SQLite reopen without model replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-task-attribution-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "chat.sqlite");
  const f = await fixture(database);
  const first = await f.send("Startup");
  f.setDecision(undefined);
  const second = await f.send("Missing decision");
  const originals = await f.engine.root.entries({}, 100, undefined, context);
  const registry = new CakeOperationRegistry(
    taskAttributionOperations({
      conversation: () => f.engine.root,
      todos: () => [todo(A), { ...todo(B), state: "done" }],
    }),
  );
  const invoke = (entryId: string, todoId: string | null) =>
    registry.invoke(
      { command: "messages.set-todo", input: { entryId, todoId } },
      { signal: new AbortController().signal, toolCallId: "repair", runtime: {} },
    );
  await invoke(String(first.entry), B);
  await expect(invoke(String(second.entry), A)).rejects.toThrow("settled human-turn");
  await expect(invoke("9007199254740992", A)).rejects.toThrow("Invalid original");
  await expect(invoke(String(first.entry), "00000000-0000-4000-8000-000000000099")).rejects.toThrow(
    "not in this chat",
  );
  expect(
    (await f.engine.root.entries({}, 100, undefined, context)).items.filter((entry) =>
      entry.kind.startsWith("pi."),
    ),
  ).toEqual(originals.items.filter((entry) => entry.kind.startsWith("pi.")));
  await f.close();
  const reopened = await fixture(database);
  expect((await reopened.doc())?.inputs[String(first.entry)]).toMatchObject({
    pending: false,
    todoId: B,
  });
  expect((await reopened.doc())?.inputs[String(second.entry)]).toMatchObject({ pending: true });
  expect(reopened.requests).toHaveLength(0);
  expect(reopened.classify).not.toHaveBeenCalled();
});

it.each([CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")])(
  "attributes shared-list side-chat admission, live snapshot, history and reopen independently (%s)",
  async (parentSessionId) => {
    const f = await fixture();
    await f.send("Startup");
    const parent = await f.doc();
    const reply = (await f.page()).parts.find(
      (part) => part.kind === "text" && part.role === "assistant",
    );
    if (reply?.kind !== "text" || !reply.entryId) throw new Error("Missing branch point");
    const sideChats = createDurableSideChats({
      parentSessionId,
      harness: f.engine.harness,
      root: f.engine.root,
      storage: f.engine.storage,
      sessionFile: "/fixture/chat.sqlite",
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
      todoContext: () => "Shared existing list",
    });
    const sessionId = await sideChats.fork(reply.entryId);
    const open = () =>
      sideChats.open({
        sessionId,
        cwd: "/fixture",
        agentDir: "/agent",
        sessionDir: "/sessions",
        requestUi: async () => undefined,
        onEvent: () => {},
      });
    const side = await open();
    try {
      f.setDecision(B);
      await side.prompt("Navigation side topic", "prompt", []);
      const snapshot = await side.snapshot();
      expect(
        snapshot.parts.find(
          (part) =>
            part.kind === "text" && part.role === "user" && part.text === "Navigation side topic",
        ),
      ).toMatchObject({ taskTodoId: B });
      expect(JSON.stringify(snapshot.parts)).not.toContain("cake-todo");
      expect(await f.doc()).toEqual(parent);
    } finally {
      await side.dispose();
    }
    const reopened = await open();
    try {
      expect(
        (await reopened.snapshot()).parts.find(
          (part) =>
            part.kind === "text" && part.role === "user" && part.text === "Navigation side topic",
        ),
      ).toMatchObject({ taskTodoId: B });
      expect(f.classify).not.toHaveBeenCalled();
    } finally {
      await reopened.dispose();
    }
  },
);

it("settles split prefix metadata before returning the first visible character and retains it on abort", async () => {
  const f = await fixture();
  const held = f.hold();
  const s = await f.submit("Startup");
  const req = await held.started;
  const project = await prepareTaskAttribution({
    conversation: f.engine.root,
    harness: f.engine.harness,
    storage: f.engine.storage,
    signal: new AbortController().signal,
    todos: () => [todo(A)],
  });
  const prefix = metadata(turnIds(req).at(-1)!, A);
  const wire = prefix + "Answer";
  let raw = "";
  let visible = "";
  for (const char of wire) {
    raw += char;
    const partial = durableAnswer(raw);
    const event = await project({ type: "text_delta", contentIndex: 0, delta: char, partial });
    if (event.type === "text_delta") visible += event.delta;
    expect(JSON.stringify(event)).not.toContain("cake-todo");
    if (raw.length <= prefix.length) expect(visible).toBe("");
    if (raw.length >= prefix.length)
      expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({
        pending: false,
        todoId: A,
      });
  }
  expect(visible).toBe("Answer");
  const interrupted = await project({
    type: "error",
    reason: "aborted",
    error: { ...durableAnswer("Answer<cake-todo>{"), stopReason: "aborted" },
  });
  expect(JSON.stringify(interrupted)).not.toContain("cake-todo");
  expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({
    pending: false,
    todoId: A,
  });
  held.finish(req, A);
  await s.wait(context);
});

it.each(["toolUse", "length"] as const)(
  "accepts a complete prefix in a coalesced %s event before forwarding its text",
  async (reason) => {
    const f = await fixture();
    const held = f.hold();
    const submission = await f.submit("Startup");
    const request = await held.started;
    const project = await prepareTaskAttribution({
      conversation: f.engine.root,
      harness: f.engine.harness,
      storage: f.engine.storage,
      signal: new AbortController().signal,
      todos: () => [todo(A)],
    });
    const message = {
      ...durableAnswer(metadata(turnIds(request).at(-1)!, A) + "Visible text"),
      stopReason: reason,
    };
    const event = await project({ type: "done", reason, message });
    expect(JSON.stringify(event)).not.toContain("cake-todo");
    expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({
      pending: false,
      todoId: A,
    });
    held.finish(request);
    await submission.wait(context);
  },
);

it("streams missing attribution immediately and never applies a late trailer or a later tool-round decision", async () => {
  const f = await fixture();
  f.setResponse((request, index) =>
    index === 1
      ? durableAnswer("", [
          { type: "text", text: "Starting without metadata" },
          { type: "toolCall", id: "create", name: "create_task", arguments: {} },
        ])
      : durableAnswer(metadata(turnIds(request).at(-1)!, B) + "Late assignment"),
  );
  const sent = await f.send("Navigation");
  expect((await f.doc())?.inputs[String(sent.entry)]).toMatchObject({
    pending: true,
    responseStarted: true,
  });
  expect(JSON.stringify((await f.page()).parts)).toContain("Starting without metadata");
  expect(JSON.stringify((await f.page()).parts)).toContain("Late assignment");

  f.setResponse((request) =>
    durableAnswer("Unrelated answer" + metadata(turnIds(request).at(-1)!, A)),
  );
  const trailer = await f.send("Other topic");
  expect((await f.doc())?.inputs[String(trailer.entry)]).toMatchObject({ pending: true });
});

it.each([false, true])(
  "preserves early attribution or incomplete-prefix pending state across abort and SQLite reopen (complete=%s)",
  async (complete) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-early-attribution-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "chat.sqlite");
    const f = await fixture(database);
    const held = f.hold();
    const s = await f.submit("Startup");
    const request = await held.started;
    const stopped = new AbortController();
    const project = await prepareTaskAttribution({
      conversation: f.engine.root,
      harness: f.engine.harness,
      storage: f.engine.storage,
      signal: stopped.signal,
      todos: () => [todo(A)],
    });
    const text = complete ? metadata(turnIds(request).at(-1)!, A) : '<cake-todo>{"turnId":';
    const event = await project({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: durableAnswer(text),
    });
    if (event.type !== "text_delta") throw new Error("Expected text delta");
    expect(event.delta).toBe("");
    stopped.abort();
    held.stream.push({
      type: "error",
      reason: "aborted",
      error: { ...durableAnswer(text), stopReason: "aborted" },
    });
    const entry = Object.keys((await f.doc())?.inputs ?? {})[0];
    if (!entry) throw new Error("Missing original input");
    await s.wait(context);
    await f.close();
    const reopened = await fixture(database);
    expect((await reopened.doc())?.inputs[entry]).toMatchObject(
      complete ? { pending: false, todoId: A } : { pending: true },
    );
    expect(reopened.requests).toHaveLength(0);
    expect(JSON.stringify((await reopened.page()).parts)).not.toContain("cake-todo");
  },
);

it("rejects a late result after its run was stopped", async () => {
  const f = await fixture();
  const held = f.hold();
  const s = await f.submit("Startup");
  const request = await held.started;
  const stopped = new AbortController();
  const project = await prepareTaskAttribution({
    conversation: f.engine.root,
    harness: f.engine.harness,
    storage: f.engine.storage,
    signal: stopped.signal,
    todos: () => [todo(A)],
  });
  const live = await f.engine.harness.snapshot(LiveDoc, f.engine.root.id, context);
  expect(live?.run).toBeDefined();
  stopped.abort();
  await project({
    type: "done",
    reason: "stop",
    message: durableAnswer(metadata(turnIds(request).at(-1)!, A)),
  });
  expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({ pending: true });
  // Also reject replay after the real request has settled and its run is gone.
  f.setDecision(undefined);
  held.stream.push({ type: "done", reason: "stop", message: durableAnswer("No decision") });
  await s.wait(context);
  await project({
    type: "done",
    reason: "stop",
    message: durableAnswer(metadata(turnIds(request).at(-1)!, A)),
  });
  expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({ pending: true });
});
