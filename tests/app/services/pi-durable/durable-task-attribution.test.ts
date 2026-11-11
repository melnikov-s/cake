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
  InboxDoc,
  UserEntry,
  AssistantEntry,
  ResetEntry,
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
import {
  durableInputText,
  durableInputPresentation,
  updateDurableInputText,
  markDurableInputSteering,
} from "../../../../src/services/pi-durable/durable-input-presentation";
import {
  previousDurableTaskContext,
  assertTaskCreationAllowed,
} from "../../../../src/services/pi-durable/durable-task-context";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import type { ProjectTodo } from "../../../../src/contracts/projects/project-todos";
import { partsFromMessage } from "../../../../src/services/pi/runtime/message-projection";
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
  let contextLimit = 300_000;
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
    contextLimitTokens: () => contextLimit,
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
  const submit = async (
    text: string,
    conversation = engine.root,
    delivery: "steer" | "followUp" = "followUp",
  ) => {
    const inbox = (await engine.harness.snapshot(InboxDoc, conversation.id, context))?.items ?? [];
    const taskContext = await previousDurableTaskContext(conversation, inbox, items);
    return conversation.submit(
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
          taskContext,
        ),
        whenBusy: delivery,
      },
      context,
    );
  };
  const openAttention = (todoId: string) =>
    engine.root.submit(
      {
        type: "input",
        content: durableInputText("Open attention", [], false, false, undefined, undefined, {
          _tag: "AttentionItem",
          todoId,
          title: todo(todoId).title,
        }),
        whenBusy: "followUp",
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
    openAttention,
    send,
    doc,
    page,
    hold,
    close,
    setContextLimit: (limit: number) => {
      contextLimit = limit;
    },
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

it("makes attention selection authoritative for the next human message and coherent follow-ups without inference or task creation", async () => {
  const f = await fixture();
  await f.send("Task A");
  await (await f.openAttention(B)).wait(context);
  const held = f.hold();
  const first = await f.submit("Proceed with that recommendation");
  const request = await held.started;
  expect(JSON.stringify(request)).toContain(`mode=\\"selected\\"`);
  expect(Object.values((await f.doc())?.inputs ?? {}).at(-1)).toMatchObject({
    pending: false,
    todoId: B,
  });
  await expect(
    assertTaskCreationAllowed(f.engine.root, f.engine.harness, f.engine.storage),
  ).rejects.toThrow("existing to-do");
  // Even an explicit-looking model transition cannot replace the user's first selected send.
  held.stream.push({
    type: "done",
    reason: "stop",
    message: durableAnswer(
      `<cake-todo>${JSON.stringify({ turnId: turnIds(request).at(-1), todoId: A, newTopic: true })}</cake-todo>Selected answer`,
    ),
  });
  const settled = await first.wait(context);
  expect(settled.status).toBe("done");
  f.setDecision(undefined);
  const second = await f.send("And check that detail too");
  f.setDecision(A);
  const third = await f.send("Continue checking it");
  const doc = await f.doc();
  if (settled.status !== "done" || settled.type !== "input") throw new Error("Expected input");
  for (const entry of [settled.entry, second.entry, third.entry])
    expect(doc?.inputs[String(entry)]).toMatchObject({ pending: false, todoId: B });
  expect(f.requests).toHaveLength(5);
  expect(f.classify).not.toHaveBeenCalled();
  expect(JSON.stringify((await f.page()).parts)).not.toContain("cake-task-context");
});

it("honors later attention selection and deliberate topic transitions, then resumes ordinary inference", async () => {
  const f = await fixture();
  await (await f.openAttention(B)).wait(context);
  await f.send("Follow B");
  await (await f.openAttention(A)).wait(context);
  f.setDecision(B);
  const selected = await f.send("Follow selected A");
  expect((await f.doc())?.inputs[String(selected.entry)]?.todoId).toBe(A);
  f.setResponse((request) =>
    durableAnswer(
      `<cake-todo>${JSON.stringify({ turnId: turnIds(request).at(-1), todoId: null, newTopic: true })}</cake-todo>Different topic`,
    ),
  );
  const unrelated = await f.send("New topic: what is the weather?");
  expect((await f.doc())?.inputs[String(unrelated.entry)]).toMatchObject({
    todoId: null,
    contextEnded: true,
  });
  // A display-only repair must not revive the ended context handoff.
  const registry = new CakeOperationRegistry(
    taskAttributionOperations({
      conversation: () => f.engine.root,
      todos: () => [todo(A), todo(B)],
    }),
  );
  await registry.invoke(
    { command: "messages.set-todo", input: { entryId: String(unrelated.entry), todoId: A } },
    { signal: new AbortController().signal, toolCallId: "repair", runtime: {} },
  );
  expect((await f.doc())?.inputs[String(unrelated.entry)]?.contextEnded).toBe(true);
  f.setResponse(undefined);
  f.setDecision(B);
  const normal = await f.send("Now navigation");
  expect((await f.doc())?.inputs[String(normal.entry)]?.todoId).toBe(B);
  expect(
    JSON.stringify(f.requests.at(-1)?.messages.findLast((message) => message.role === "user")),
  ).not.toContain("cake-task-context");
});

it("captures queued selection changes without allowing a late prior-task response to restore its context", async () => {
  const C = "00000000-0000-4000-8000-000000000003";
  const f = await fixture();
  f.setTodos([todo(A), todo(B), todo(C)]);
  const held = f.hold();
  const old = await f.submit("Old A question");
  const request = await held.started;
  await expect(
    assertTaskCreationAllowed(f.engine.root, f.engine.harness, f.engine.storage),
  ).resolves.toBeUndefined();
  const attentionB = await f.openAttention(B);
  const sendB = await f.submit("Queued B reply");
  const attentionC = await f.openAttention(C);
  const sendC = await f.submit("Queued C reply");
  held.finish(request, A);
  await Promise.all([old, attentionB, attentionC].map((s) => s.wait(context)));
  for (const [submission, todoId] of [
    [sendB, B],
    [sendC, C],
  ] as const) {
    const result = await submission.wait(context);
    if (result.status !== "done" || result.type !== "input") throw new Error("Expected input");
    expect((await f.doc())?.inputs[String(result.entry)]?.todoId).toBe(todoId);
  }
  const follow = await f.send("Keep going");
  expect((await f.doc())?.inputs[String(follow.entry)]?.todoId).toBe(C);
});

it("does not consume withdrawn attention and preserves explicit context across queue edits and steering", async () => {
  const f = await fixture();
  const held = f.hold();
  const old = await f.submit("A question");
  const request = await held.started;
  const withdrawn = await f.openAttention(B);
  await f.engine.harness.abortSubmission(withdrawn.id, context, f.engine.root.id);
  const inbox = (await f.engine.harness.snapshot(InboxDoc, f.engine.root.id, context))?.items ?? [];
  expect(
    await previousDurableTaskContext(f.engine.root, inbox, [todo(A), todo(B)]),
  ).toBeUndefined();
  const attention = await f.openAttention(B);
  const current =
    (await f.engine.harness.snapshot(InboxDoc, f.engine.root.id, context))?.items ?? [];
  const selected = await previousDurableTaskContext(f.engine.root, current, [todo(A), todo(B)]);
  expect(selected).toEqual({ todoId: B, first: true });
  const encoded = durableInputText(
    "Reply",
    [],
    false,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    f.engine.root.id,
    selected,
  );
  expect(
    durableInputPresentation(
      markDurableInputSteering(updateDurableInputText(encoded, "Edited reply")),
    ).taskContext,
  ).toEqual(selected);
  const steer = await f.submit("Steered B reply", f.engine.root, "steer");
  held.finish(request);
  await Promise.all([old, attention, steer].map((s) => s.wait(context)));
  const doc = await f.doc();
  expect(Object.values(doc?.inputs ?? {}).at(-1)).toMatchObject({ todoId: B });
});

it("recovers an unconsumed attention handoff and subsequent context from durable originals after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-explicit-task-context-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "chat.sqlite");
  const first = await fixture(database);
  await first.send("A question");
  await (await first.openAttention(B)).wait(context);
  await first.close();
  const second = await fixture(database);
  const follow = await second.send("Reply after restart");
  expect((await second.doc())?.inputs[String(follow.entry)]?.todoId).toBe(B);
  await second.close();
  const third = await fixture(database);
  const followAgain = await third.send("Continue after another restart");
  expect((await third.doc())?.inputs[String(followAgain.entry)]?.todoId).toBe(B);
});

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
  expect(
    page.parts
      .filter((part) => part.kind === "text" && part.role === "assistant")
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

it("independently attributes repeated topic changes after omitted prefixes", async () => {
  const f = await fixture();
  const choices = [A, undefined, B, undefined, null, A];
  const expected = [A, null, B, null, null, A];
  for (const [index, choice] of choices.entries()) {
    f.setDecision(choice);
    const sent = await f.send(
      ["Startup", "Unmatched topic", "Navigation", "Another topic", "No task", "Return to startup"][
        index
      ]!,
    );
    expect((await f.doc())?.inputs[String(sent.entry)]).toMatchObject({
      pending: false,
      todoId: expected[index],
    });
  }
  expect(
    (await f.page()).parts.flatMap((part) =>
      part.kind === "text" && part.role === "user" ? [part.taskTodoId] : [],
    ),
  ).toEqual(expected);
  expect(f.requests).toHaveLength(choices.length);
  expect(JSON.stringify(f.requests[0])).toContain("For EVERY current human");
  expect(JSON.stringify(f.requests[0])).toContain("Updating a to-do or launching a session");
});

it("does not let cross-session reports decide for themselves or revise the preceding human turn", async () => {
  const f = await fixture();
  const human = await f.send("Startup");
  const before = await f.doc();
  f.setResponse((request) =>
    durableAnswer(
      turnIds(request)
        .flatMap((id) => (id ? [metadata(id, B)] : []))
        .join("") + "Report received",
    ),
  );
  const report = await f.send(
    `<cake-session-message>${JSON.stringify({
      version: 1,
      messageId: A,
      threadId: A,
      sequence: 1,
      expectsResponse: true,
      sender: { sessionId: "worker", title: "Navigation", kind: "project-session" },
    })}</cake-session-message>\nNavigation report`,
  );
  // The fixture deliberately gives the report a token: provenance still excludes it.
  expect((await f.doc())?.inputs[String(report.entry)]).toBeUndefined();
  expect((await f.doc())?.inputs[String(human.entry)]).toEqual(before?.inputs[String(human.entry)]);
  f.setResponse(undefined);
  f.setDecision(null);
  const next = await f.send("An unrelated human question");
  expect((await f.doc())?.inputs[String(next.entry)]).toMatchObject({
    pending: false,
    todoId: null,
  });
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
  "settles %s decisions ungrouped before prose rather than inheriting a previous task",
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
    expect(user).toMatchObject({ taskTodoId: null });
    expect(user).not.toHaveProperty("taskAttributionPending");
    const doc = await f.doc();
    expect(Object.values(doc?.inputs ?? {}).at(-1)).toMatchObject({
      pending: false,
      todoId: null,
      responseStarted: true,
    });
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
  expect((await f.doc())?.inputs[String(last.entry)]).toMatchObject({
    pending: false,
    todoId: null,
    responseStarted: true,
  });
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

it("keeps omitted and explicit decisions and manual corrections across SQLite reopen without model replay", async () => {
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
  // Once prose has started, omitted metadata is settled and explicitly repairable.
  await invoke(String(second.entry), null);
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
  expect((await reopened.doc())?.inputs[String(second.entry)]).toMatchObject({
    pending: false,
    todoId: null,
  });
  const replies = (await reopened.page()).parts.filter(
    (part) => part.kind === "text" && part.role === "assistant",
  );
  expect(replies[0]).toMatchObject({ taskTodoId: B });
  expect(replies[1]).toMatchObject({ taskTodoId: null });
  expect(replies[1]).not.toHaveProperty("taskAttributionPending");
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

it.each(["", " \n\t\n "])(
  "keeps a standalone metadata-only original without a response part (%j)",
  async (whitespace) => {
    const f = await fixture();
    f.setResponse((request) => durableAnswer(metadata(turnIds(request).at(-1)!, A) + whitespace));
    const sent = await f.send("Startup");
    expect(
      (await f.page()).parts.filter((part) => part.kind === "text" && part.role === "assistant"),
    ).toEqual([]);
    expect((await f.doc())?.inputs[String(sent.entry)]).toMatchObject({
      pending: false,
      todoId: A,
    });
    const originals = await f.engine.root.entries({}, 200, undefined, context);
    expect(originals.items.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
  },
);

it("keeps metadata-only provider errors and reasoning visible as their own parts", async () => {
  const f = await fixture();
  const project = await prepareTaskAttribution({
    conversation: f.engine.root,
    harness: f.engine.harness,
    storage: f.engine.storage,
    signal: new AbortController().signal,
    todos: () => [todo(A)],
  });
  const message = {
    ...durableAnswer(metadata(A, A) + " \n", [
      { type: "text" as const, text: metadata(A, A) + " \n" },
      { type: "thinking" as const, thinking: "Checking the request" },
    ]),
    stopReason: "error" as const,
    errorMessage: "Provider disconnected",
  };
  const event = await project({ type: "error", reason: "error", error: message });
  if (event.type !== "error") throw new Error("Expected provider error");
  expect(partsFromMessage(event.error, "failure")).toEqual([
    expect.objectContaining({ kind: "reasoning", text: "Checking the request" }),
    expect.objectContaining({ kind: "notice", tone: "error", detail: "Provider disconnected" }),
  ]);
});

it.each(["", " \n\t\n "])(
  "omits attribution-only response surfaces without deleting originals or tool activity (whitespace=%j)",
  async (whitespace) => {
    const f = await fixture();
    f.setResponse((request, index) =>
      index === 1
        ? durableAnswer("", [
            { type: "text", text: metadata(turnIds(request).at(-1)!, A) + whitespace },
            { type: "toolCall", id: "create", name: "create_task", arguments: {} },
          ])
        : durableAnswer("Complete answer"),
    );
    const result = await f.send("Startup");
    const page = await f.page();
    expect((await f.doc())?.inputs[String(result.entry)]).toMatchObject({
      pending: false,
      todoId: A,
    });
    expect(
      page.parts.filter((part) => part.kind === "text" && part.role === "assistant"),
    ).toMatchObject([{ text: "Complete answer" }]);
    expect(page.parts).toContainEqual(expect.objectContaining({ kind: "tool", state: "success" }));
    const originals = await f.engine.root.entries({}, 200, undefined, context);
    const assistants = originals.items.filter((entry) => entry.kind === "pi.assistant");
    expect(assistants).toHaveLength(2);
    expect(
      assistants.some((entry) =>
        entry.model?.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((block) => block.type === "text" && block.text === whitespace),
        ),
      ),
    ).toBe(true);
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
  const wire = " \n" + prefix + " \nAnswer";
  let raw = "";
  let visible = "";
  for (const char of wire) {
    raw += char;
    const partial = durableAnswer(raw);
    const event = await project({ type: "text_delta", contentIndex: 0, delta: char, partial });
    if (event.type === "text_delta") visible += event.delta;
    expect(JSON.stringify(event)).not.toContain("cake-todo");
    const visibleMessage = event.type === "text_delta" ? event.partial : partial;
    const parts = partsFromMessage(visibleMessage, "live", true);
    const projected = await readDurableOriginalPage(
      f.engine.root,
      undefined,
      undefined,
      undefined,
      undefined,
      (await f.doc())?.inputs,
      undefined,
      { id: "live", message: visibleMessage },
    );
    const reply = projected.parts.findLast(
      (part) => part.kind === "text" && part.role === "assistant",
    );
    if (raw.length > wire.indexOf("Answer"))
      expect(reply).toMatchObject({ taskTodoId: A, status: "streaming" });
    if (raw.length <= wire.indexOf("Answer"))
      expect(parts.filter((part) => part.kind === "text")).toEqual([]);
    else
      expect(parts).toContainEqual(
        expect.objectContaining({
          kind: "text",
          text: " \n \n" + wire.slice(wire.indexOf("Answer"), raw.length),
        }),
      );
    if (raw.length >= wire.indexOf("Answer"))
      expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({
        pending: false,
        todoId: A,
      });
  }
  expect(visible).toBe(" \n \nAnswer");
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

it("settles missing metadata before forwarding streamed prose and rejects a later prefix", async () => {
  const f = await fixture();
  await f.send("Startup");
  const held = f.hold();
  const submission = await f.submit("An unrelated topic");
  const request = await held.started;
  const project = await prepareTaskAttribution({
    conversation: f.engine.root,
    harness: f.engine.harness,
    storage: f.engine.storage,
    signal: new AbortController().signal,
    todos: () => [todo(A), todo(B)],
  });
  const event = await project({
    type: "text_delta",
    contentIndex: 0,
    delta: "Answer without a prefix",
    partial: durableAnswer("Answer without a prefix"),
  });
  expect(event.type === "text_delta" && event.delta).toBe("Answer without a prefix");
  expect(
    (await f.page()).parts.findLast((part) => part.kind === "text" && part.role === "user"),
  ).toMatchObject({ taskTodoId: null });
  const settled = await f.doc();
  await project({
    type: "done",
    reason: "stop",
    message: durableAnswer(metadata(turnIds(request).at(-1)!, B) + "Late replacement"),
  });
  expect(await f.doc()).toEqual(settled);
  held.finish(request, B);
  await submission.wait(context);
  expect(await f.doc()).toEqual(settled);
});

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
    pending: false,
    todoId: null,
    responseStarted: true,
  });
  expect(JSON.stringify((await f.page()).parts)).toContain("Starting without metadata");
  expect(JSON.stringify((await f.page()).parts)).toContain("Late assignment");

  f.setResponse((request) =>
    durableAnswer("Unrelated answer" + metadata(turnIds(request).at(-1)!, A)),
  );
  const trailer = await f.send("Other topic");
  expect((await f.doc())?.inputs[String(trailer.entry)]).toMatchObject({
    pending: false,
    todoId: null,
    responseStarted: true,
  });
});

it.each([false, true])(
  "preserves early attribution or incomplete-prefix pending state across abort and SQLite reopen (complete=%s)",
  async (complete) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-early-attribution-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "chat.sqlite");
    const f = await fixture(database);
    await f.send("Historical detail ".repeat(2000));
    f.setContextLimit(6000);
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
      error: {
        ...durableAnswer(text + (complete ? "Interrupted answer" : "")),
        stopReason: "aborted",
      },
    });
    const entry = Object.keys((await f.doc())?.inputs ?? {}).at(-1);
    if (!entry) throw new Error("Missing original input");
    await s.wait(context);
    await f.close();
    const reopened = await fixture(database);
    expect((await reopened.doc())?.inputs[entry]).toMatchObject(
      complete ? { pending: false, todoId: A } : { pending: true },
    );
    expect(reopened.requests).toHaveLength(0);
    expect(JSON.stringify((await reopened.page()).parts)).not.toContain("cake-todo");
    if (complete) {
      reopened.setDecision(B);
      await reopened.send("New human topic");
      const parts = (await reopened.page()).parts;
      expect(
        parts.find((part) => part.kind === "text" && part.text === "Interrupted answer"),
      ).toMatchObject({ taskTodoId: A });
      expect(
        parts.findLast((part) => part.kind === "text" && part.role === "assistant"),
      ).toMatchObject({ taskTodoId: B });
    }
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
  expect(Object.values((await f.doc())?.inputs ?? {})[0]).toMatchObject({
    pending: false,
    todoId: null,
    responseStarted: true,
  });
});

it.each([A, null])(
  "keeps original-turn identity through an engine memory reset, streaming and SQLite reopen (%s)",
  async (decision) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-reset-attribution-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "chat.sqlite");
    const f = await fixture(database);
    f.setDecision(B);
    await f.send("Historical detail ".repeat(2000));
    f.setContextLimit(6000);
    const held = f.hold();
    const submission = await f.submit("Current human question");
    const request = await held.started;
    const originals = (await f.engine.root.entries({}, 200, undefined, context)).items;
    const reset = originals.find((entry) => entry.kind === "pi.reset");
    // This record is produced by the engine, not a synthetic ordinary-input fixture.
    expect(reset?.model?.filter((message) => message.role === "user")).toHaveLength(2);
    expect(JSON.stringify(reset?.model)).toContain("<current-time>");
    expect(JSON.stringify(reset?.model)).toContain("Current human question");
    expect(JSON.stringify(reset?.model)).toContain("cake-input-presentation");
    const readLive = async () =>
      readDurableOriginalPage(
        f.engine.root,
        undefined,
        undefined,
        undefined,
        undefined,
        (await f.doc())?.inputs,
        undefined,
        { id: "live-reset-answer", message: durableAnswer("Streaming reset answer") },
      );
    expect((await readLive()).parts.at(-1)).toMatchObject({
      taskAttributionPending: true,
      status: "streaming",
    });
    const project = await prepareTaskAttribution({
      conversation: f.engine.root,
      harness: f.engine.harness,
      storage: f.engine.storage,
      signal: new AbortController().signal,
      todos: () => [todo(A), todo(B)],
    });
    const text = metadata(turnIds(request).at(-1)!, decision) + "Streaming reset answer";
    await project({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: durableAnswer(text),
    });
    const live = (await readLive()).parts.at(-1);
    // Capture while the run is active, then settle before asserting so failure closes cleanly.
    held.finish(request, decision);
    await submission.wait(context);
    expect(live).toMatchObject({ taskTodoId: decision, status: "streaming" });
    expect(live).not.toHaveProperty("taskAttributionPending");
    expect((await f.page()).parts.findLast((part) => part.kind === "text")).toMatchObject({
      text: "Held answer",
      taskTodoId: decision,
    });
    await f.engine.root.commit(async (tx) => {
      for (let i = 0; i < 205; i += 1)
        await tx.appendEntry(f.engine.root.id, { kind: "cake.context", data: {} });
      await tx.appendEntry(AssistantEntry, f.engine.root.id, {
        model: [durableAnswer("Later original final")],
      });
    }, context);
    await f.close();
    const reopened = await fixture(database);
    const newest = await reopened.page();
    expect(newest.parts.find((part) => part.kind === "text")).toMatchObject({
      text: "Later original final",
      taskTodoId: decision,
    });
    expect(newest.cursor).toBeDefined();
    const earlier = await readDurableOriginalPage(
      reopened.engine.root,
      newest.cursor,
      undefined,
      undefined,
      undefined,
      (await reopened.doc())?.inputs,
    );
    const parts = earlier.parts;
    for (const text of ["Current human question", "Held answer"]) {
      const part = parts.find((part) => part.kind === "text" && part.text === text);
      expect(part).toMatchObject({ taskTodoId: decision });
      expect(part).not.toHaveProperty("taskAttributionPending");
    }
    expect(reopened.requests).toHaveLength(0);
  },
);

it.each([
  { pending: false, todoId: A },
  { pending: false, todoId: null },
  { pending: true, todoId: null },
])(
  "scans past reset/control model inputs across history pages without crossing original inputs (%j)",
  async (identity) => {
    const f = await fixture();
    const sent = await f.send("Original human");
    await f.engine.root.commit(async (tx) => {
      (await tx.doc(TaskAttributionDoc, f.engine.root.id)).inputs[String(sent.entry)] = identity;
      const original = await tx.entry(sent.entry);
      // Engine-shaped reset: summary user input followed by the copied current input.
      // Both carry model inputs, but neither is a new original human turn.
      for (let i = 0; i < 205; i += 1)
        await tx.appendEntry(ResetEntry, f.engine.root.id, {
          head: "self",
          model: [
            { role: "user", content: "Summary <current-time>now</current-time>", timestamp: 2000 },
            ...(original?.model ?? []),
          ],
        });
      await tx.appendEntry(f.engine.root.id, {
        kind: "cake.control",
        model: [{ role: "user", content: "Control-only model input", timestamp: 2000 }],
      });
      await tx.appendEntry(AssistantEntry, f.engine.root.id, {
        model: [durableAnswer("Answer after reset-only page")],
      });
    }, context);
    const expected = identity.pending
      ? { taskAttributionPending: true }
      : { taskTodoId: identity.todoId };
    const newest = await f.page();
    expect(newest.parts.find((part) => part.kind === "text")).toMatchObject({
      text: "Answer after reset-only page",
      ...expected,
    });
    const earlier = await readDurableOriginalPage(
      f.engine.root,
      newest.cursor,
      undefined,
      undefined,
      undefined,
      (await f.doc())?.inputs,
    );
    expect(
      earlier.parts.find((part) => part.kind === "text" && part.role === "assistant"),
    ).toMatchObject(expected);
    expect(f.requests).toHaveLength(1);
  },
);

it("includes every reply across an original-history page edge without replay or manual source links", async () => {
  const f = await fixture();
  const sent = await f.send("Startup");
  await f.engine.root.commit(async (tx) => {
    for (let i = 0; i < 205; i += 1)
      await tx.appendEntry(AssistantEntry, f.engine.root.id, {
        model: [{ ...durableAnswer("Continuation " + i), timestamp: 1000 + i }],
      });
  }, context);
  const attributions = (await f.doc())?.inputs;
  const newest = await readDurableOriginalPage(
    f.engine.root,
    undefined,
    undefined,
    undefined,
    undefined,
    attributions,
  );
  expect(newest.cursor).toBeDefined();
  expect(newest.parts.filter((part) => part.kind === "text")).toHaveLength(200);
  expect(
    newest.parts.filter((part) => part.kind === "text").every((part) => part.taskTodoId === A),
  ).toBe(true);
  const earlier = await readDurableOriginalPage(
    f.engine.root,
    newest.cursor,
    undefined,
    undefined,
    undefined,
    attributions,
  );
  expect(earlier.parts).toContainEqual(
    expect.objectContaining({ entryId: String(sent.entry), taskTodoId: A }),
  );
  expect(
    earlier.parts
      .filter((part) => part.kind === "text" && part.role === "assistant")
      .every((part) => part.kind === "text" && part.taskTodoId === A),
  ).toBe(true);
  expect(f.requests).toHaveLength(1);
  expect(f.classify).not.toHaveBeenCalled();
});

it("bounds reply identity at new human, incoming report, automatic, pending and null inputs, never source cards", async () => {
  const f = await fixture();
  await f.send("Startup");
  await f.engine.root.commit(async (tx) => {
    let currentInput = "Startup";
    const appendInput = async (
      text: string,
      attribution?: { pending: boolean; todoId: string | null },
    ) => {
      const entry = await tx.appendEntry(UserEntry, f.engine.root.id, {
        model: [{ role: "user", content: text, timestamp: 2000 }],
      });
      if (attribution)
        (await tx.doc(TaskAttributionDoc, f.engine.root.id)).inputs[String(entry.id)] = attribution;
      currentInput = text;
    };
    const appendReply = async (text: string) => {
      // More than one scan page of context copies must not hide the genuine
      // automatic/report/human boundary from the backwards attribution lookup.
      for (let i = 0; i < 205; i += 1)
        await tx.appendEntry(ResetEntry, f.engine.root.id, {
          head: "self",
          model: [
            { role: "user", content: "Summary", timestamp: 2000 },
            { role: "user", content: currentInput, timestamp: 2000 },
          ],
        });
      return tx.appendEntry(AssistantEntry, f.engine.root.id, {
        model: [durableAnswer(text)],
      });
    };
    await appendReply("Second block in same answer");
    await tx.appendEntry(f.engine.root.id, {
      kind: "cake.source-card",
      data: { title: "Unrelated source" },
    });
    await appendReply("Answer after display-only source card");
    const crossSession = {
      version: 1,
      messageId: A,
      threadId: A,
      sequence: 1,
      expectsResponse: false,
      sender: { sessionId: "worker", title: "Worker", kind: "project-session" },
    };
    await appendInput(
      "<cake-session-message>" +
        JSON.stringify(crossSession) +
        "</cake-session-message>\nWorker findings",
    );
    await appendReply("Reply to incoming worker");
    await appendInput(
      durableInputText("Timer", [], false, false, undefined, undefined, {
        _tag: "UpdateBatch",
        notices: [],
      }),
    );
    await appendReply("Reply to automatic input");
    await appendInput(
      durableInputText("Research findings", [], false, false, {
        handleId: A,
        task: "Research",
        status: "complete",
        fastMode: false,
        resolvedModel: {
          requested: "current",
          source: "current",
          provider: "fixture",
          modelId: "fixture",
          thinkingLevel: "off",
          fallbacks: [],
        },
      }),
    );
    await appendReply("Reply to subagent report");
    await appendInput("Unmatched human", { pending: false, todoId: null });
    await appendReply("Unmatched answer");
    await appendInput("Unsettled human", { pending: true, todoId: null });
    await appendReply("Pending answer");
    await appendInput("Switch to navigation", { pending: false, todoId: B });
    await appendReply("Navigation answer");
    await appendInput("Legacy untagged human");
    await appendReply("Legacy untagged answer");
  }, context);
  const parts = [];
  let cursor: string | undefined;
  do {
    const page = await readDurableOriginalPage(
      f.engine.root,
      cursor,
      undefined,
      undefined,
      undefined,
      (await f.doc())?.inputs,
    );
    parts.push(...page.parts);
    cursor = page.cursor;
  } while (cursor !== undefined);
  for (const text of ["Second block in same answer", "Answer after display-only source card"])
    expect(parts.find((part) => part.kind === "text" && part.text === text)).toMatchObject({
      taskTodoId: A,
    });
  for (const text of [
    "Reply to incoming worker",
    "Reply to automatic input",
    "Reply to subagent report",
    "Legacy untagged answer",
  ]) {
    const part = parts.find((part) => part.kind === "text" && part.text === text);
    expect(part).not.toHaveProperty("taskTodoId");
    expect(part).not.toHaveProperty("taskAttributionPending");
  }
  expect(
    parts.find((part) => part.kind === "text" && part.text === "Unmatched answer"),
  ).toMatchObject({ taskTodoId: null });
  expect(
    parts.find((part) => part.kind === "text" && part.text === "Pending answer"),
  ).toMatchObject({ taskAttributionPending: true });
  expect(
    parts.find((part) => part.kind === "text" && part.text === "Navigation answer"),
  ).toMatchObject({ taskTodoId: B });
});
