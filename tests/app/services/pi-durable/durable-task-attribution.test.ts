import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-durable-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { TaskAttributionDoc } from "../../../../src/services/pi-durable/durable-task-attribution";
import { taskAttributionOperations } from "../../../../src/services/pi-durable/durable-task-attribution-operations";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import type { ProjectTodo } from "../../../../src/contracts/projects/project-todos";
import type { InternalInput } from "../../../../src/contracts/conversations/internal-input";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<void>> = [];
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

async function fixture(
  withTool = false,
  database?: string,
  withTodos = true,
  createdTodo = todo(A),
) {
  const f = durableModels((_request, index) =>
    withTool && index === 1
      ? durableAnswer("", [
          { type: "toolCall", id: "create-task", name: "create_task", arguments: {} },
        ])
      : durableAnswer("Normal streamed answer"),
  );
  let items = withTool ? [] : [todo(A), todo(B)];
  const utility = { ...durableModel, provider: "utility-provider", id: "fast-utility" };
  vi.mocked(f.models.getModel).mockImplementation((provider, id) =>
    provider === utility.provider && id === utility.id ? utility : durableModel,
  );
  const utilityModel = vi.fn(
    (): { provider: string; modelId: string; thinkingLevel: "off" } | undefined => ({
      provider: utility.provider,
      modelId: utility.id,
      thinkingLevel: "off",
    }),
  );
  const classify = vi
    .spyOn(f.models, "completeSimple")
    .mockResolvedValue(durableAnswer(JSON.stringify({ todoId: A })));
  const reports = vi.fn();
  const registry = createRegistry();
  const tool = defineTool({
    name: "create_task",
    description: "Create task",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      items = [...items, createdTodo];
      return { output: [{ type: "text", text: "Created" }] };
    },
  });
  registry.install(defineExtension({ name: "test", tools: [tool] }));
  const engine = await openDurableChatEngine({
    storage: database ? await openNodeSqliteStorage(database) : new MemoryStorage(),
    models: f.models,
    registry,
    agent: { model: { provider: "fixture", modelId: "fixture" }, tools: withTool ? [tool] : [] },
    memory: { budget: () => 4000, summarize: async () => "memory" },
    todos: withTodos ? () => items : undefined,
    utilityModel,
    onChanged: vi.fn(),
    onReport: reports,
  });
  cleanup.push(() => engine.close());
  const send = async (text: string, internal?: InternalInput) => {
    const submission = await engine.root.submit(
      {
        type: "input",
        content: durableInputText(text, [], false, false, undefined, undefined, internal),
      },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input")
      throw new Error("Main response failed");
    return settled;
  };
  const finish = async () => {
    const tasks = await engine.root.commit(
      (tx) => tx.scanTasks({ conversationId: engine.root.id, kind: "cake.task-attribution" }, 100),
      context,
    );
    await Promise.all(tasks.items.map((task) => engine.harness.waitForTask(task.id, context)));
    return engine.harness.snapshot(TaskAttributionDoc, engine.root.id, context);
  };
  return {
    ...f,
    engine,
    classify,
    send,
    finish,
    reports,
    utility,
    utilityModel,
    setTodos: (value: ProjectTodo[]) => {
      items = value;
    },
  };
}

it("runs once per human input on the separate utility model and projects A → A → B → A → none without rewriting originals", async () => {
  const f = await fixture();
  const decisions = [A, A, B, A, null];
  for (const id of decisions)
    f.classify.mockResolvedValueOnce(durableAnswer(JSON.stringify({ todoId: id })));
  const inputs = [];
  for (const text of [
    "Investigate startup",
    "Check config reads too",
    "Switch to navigation",
    "Back to startup",
    "Unrelated: what is the weather in Oslo?",
  ]) {
    const settled = await f.send(text);
    inputs.push(String(settled.entry));
    await f.finish();
  }
  expect(f.classify).toHaveBeenCalledTimes(5);
  const doc = await f.finish();
  expect(inputs.map((id) => doc?.inputs[id]?.todoId)).toEqual(decisions);
  expect(f.classify.mock.calls[0]?.[0]).toMatchObject({
    provider: "utility-provider",
    id: "fast-utility",
  });
  expect(f.classify.mock.calls[0]?.[2]).toMatchObject({
    maxTokens: 256,
    reasoning: undefined,
    toolChoice: "none",
    signal: expect.any(AbortSignal),
  });
  const originals = await f.engine.root.entries({}, 200, undefined, context);
  const page = await readDurableOriginalPage(
    f.engine.root,
    undefined,
    undefined,
    undefined,
    undefined,
    doc?.inputs,
  );
  expect(
    page.parts
      .filter((p) => p.kind === "text" && p.role === "user")
      .map((p) => (p.kind === "text" ? p.taskTodoId : undefined)),
  ).toEqual(decisions);
  expect(
    (await f.engine.root.entries({}, 200, undefined, context)).items.filter((entry) =>
      entry.kind.startsWith("pi."),
    ),
  ).toEqual(originals.items.filter((entry) => entry.kind.startsWith("pi.")));
  expect(f.reports).not.toHaveBeenCalled();
});

it("supplies settled continuity evidence for short follow-ups without overriding switches or null decisions", async () => {
  const f = await fixture();
  const turns = [
    ["Investigate startup", A, null],
    ["Yes", A, A],
    ["What about that?", A, A],
    ["Go ahead", A, A],
    ["Actually switch to navigation", B, A],
    ["Unrelated: what is the weather in Oslo?", null, B],
    ["And tomorrow?", null, null],
    ["Back to startup", A, null],
  ] as const;
  for (const [text, decision, previousTodoId] of turns) {
    f.classify.mockResolvedValueOnce(durableAnswer(JSON.stringify({ todoId: decision })));
    const sent = await f.send(text);
    const doc = await f.finish();
    expect(doc?.inputs[String(sent.entry)]).toEqual({ pending: false, todoId: decision });
    const request = f.classify.mock.calls.at(-1)?.[1].messages;
    const content = request?.[1]?.content;
    if (typeof content !== "string") throw new Error("Expected classifier JSON");
    const payload = JSON.parse(content);
    expect(payload.previousTodoId).toBe(previousTodoId);
    expect(payload.messages.at(-1).text).toBe(text);
    expect(request?.[0]?.content).toContain("do not return null merely because");
    expect(request?.[0]?.content).toContain(
      "never keep a task just because it was previously active",
    );
  }
  expect(f.classify).toHaveBeenCalledTimes(turns.length);
});

it.each([true, false])(
  "treats broader merge-and-resolve work as a switch after PDF resize discussion (matching to-do: %s)",
  async (matchingTodo) => {
    const f = await fixture();
    f.setTodos([
      {
        ...todo(A),
        title: "Fix PDF auto-fit behavior",
        description: "Recalculate fit on window and reader resize.",
      },
      ...(matchingTodo
        ? [
            {
              ...todo(B),
              title: "Merge and resolve completed sessions",
              description: "Manage all sessions as they finish.",
            },
          ]
        : []),
    ]);
    const decisions = [A, A, matchingTodo ? B : null];
    for (const [index, text] of [
      "Fix PDF auto-fit behavior",
      "it doesn't resize when it should, like window resize",
      "merge and resolve and sessions as they finish",
    ].entries()) {
      f.classify.mockResolvedValueOnce(durableAnswer(JSON.stringify({ todoId: decisions[index] })));
      const sent = await f.send(text);
      const doc = await f.finish();
      expect(doc?.inputs[String(sent.entry)]?.todoId).toBe(decisions[index]);
    }
    const messages = f.classify.mock.calls.at(-1)?.[1].messages;
    const content = messages?.[1]?.content;
    if (typeof content !== "string") throw new Error("Expected classifier JSON");
    const payload = JSON.parse(content);
    expect(payload.previousTodoId).toBe(A);
    expect(payload.messages.at(-1).text).toBe("merge and resolve and sessions as they finish");
    expect(
      payload.messages.some((message: { text: string }) => message.text.includes("window resize")),
    ).toBe(true);
    expect(messages?.[0]?.content).toContain("a task switch, not a PDF follow-up");
  },
);

it.each(["continuation", "unrelated", "failure"] as const)(
  "projects pending attribution separately, then honors the settled %s rather than hiding it",
  async (outcome) => {
    const f = await fixture();
    await f.send("Investigate startup");
    await f.finish();
    let release!: () => void;
    let started!: () => void;
    const deciding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const decision = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.classify.mockImplementationOnce(async () => {
      started();
      await decision;
      if (outcome === "failure") throw new Error("Provider offline");
      return durableAnswer(JSON.stringify({ todoId: outcome === "continuation" ? A : null }));
    });
    const sent = await f.send(outcome === "unrelated" ? "Unrelated: weather in Oslo?" : "Yes");
    await deciding;
    const project = async () => {
      const doc = await f.engine.harness.snapshot(TaskAttributionDoc, f.engine.root.id, context);
      const page = await readDurableOriginalPage(
        f.engine.root,
        undefined,
        undefined,
        undefined,
        undefined,
        doc?.inputs,
      );
      return page.parts.find((part) => part.kind === "text" && part.entryId === String(sent.entry));
    };
    expect(await project()).toMatchObject({ taskAttributionPending: true });
    release();
    await f.finish();
    const settled = await project();
    expect(settled).toMatchObject({ taskTodoId: outcome === "continuation" ? A : null });
    expect(settled).not.toHaveProperty("taskAttributionPending");
    expect(f.reports).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
  },
);

it("attributes human inputs carrying reminders but not automatic deliveries", async () => {
  const f = await fixture();
  const human = await f.send("Discuss startup", {
    _tag: "UserWithReminders",
    text: "Discuss startup",
    userText: "Discuss startup",
    notices: [],
  });
  await f.finish();
  for (const internal of [
    { _tag: "UpdateBatch", notices: [] },
    { _tag: "WorkboardDelivery", boardId: "board", sequences: [1] },
    { _tag: "SubagentCompletion", details: {} },
  ] satisfies InternalInput[])
    await f.send("Automatic startup update", internal);
  const doc = await f.finish();
  expect(f.classify).toHaveBeenCalledTimes(1);
  expect(doc?.inputs).toEqual({ [String(human.entry)]: { pending: false, todoId: A } });
});

it("does not block the normal response or start an agent/tool round for attribution", async () => {
  const f = await fixture();
  let release: (value: ReturnType<typeof durableAnswer>) => void = () => {
    throw new Error("Not started");
  };
  let notifyStarted = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const decision = new Promise<ReturnType<typeof durableAnswer>>((resolve) => {
    release = resolve;
  });
  f.classify.mockImplementation(() => {
    notifyStarted();
    return decision;
  });
  const settled = await f.send("Startup please");
  expect(settled.status).toBe("done");
  const originals = await f.engine.root.entries({}, 200, undefined, context);
  const tasks = await f.engine.root.commit(
    (tx) => tx.scanTasks({ conversationId: f.engine.root.id, kind: "cake.task-attribution" }, 100),
    context,
  );
  // A deterministic start signal, not elapsed time, releases the external model boundary.
  await started;
  release(durableAnswer(JSON.stringify({ todoId: A })));
  await Promise.all(tasks.items.map((task) => f.engine.harness.waitForTask(task.id, context)));
  expect(
    (await f.engine.root.entries({}, 200, undefined, context)).items.filter((entry) =>
      entry.kind.startsWith("pi."),
    ),
  ).toEqual(originals.items.filter((entry) => entry.kind.startsWith("pi.")));
  expect(f.requests).toHaveLength(1);
});

it("keeps attribution across SQLite reopen without classifying old messages again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-task-attribution-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "chat.sqlite");
  const first = await fixture(false, database);
  const settled = await first.send("Investigate startup");
  const before = await first.finish();
  await first.engine.close();
  const second = await fixture(false, database);
  second.engine.harness.resume();
  const after = await second.engine.harness.snapshot(
    TaskAttributionDoc,
    second.engine.root.id,
    context,
  );
  expect(after).toEqual(before);
  expect(after?.inputs[String(settled.entry)]?.todoId).toBe(A);
  expect(second.classify).not.toHaveBeenCalled();
});

it.each([
  { initial: null, final: A },
  { initial: B, final: A },
  { initial: B, final: null },
  { initial: B, final: "failure" },
])(
  "reconsiders initial $initial when the response creates a candidate (final: $final)",
  async ({ initial, final }) => {
    const f = await fixture(true, undefined, true, {
      ...todo(A),
      title: "Prototype Cake-set needs-attention to-dos",
    });
    f.setTodos([{ ...todo(B), title: "Assess Ultimate ideas applicable to Cake" }]);
    const stream = createAssistantMessageEventStream();
    vi.mocked(f.models.streamSimple).mockReturnValueOnce(stream);
    let started = () => {};
    const classified = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.classify.mockImplementationOnce(async () => {
      started();
      return durableAnswer(JSON.stringify({ todoId: initial }));
    });
    if (final === "failure") f.classify.mockRejectedValueOnce(new Error("Provider offline"));
    else f.classify.mockResolvedValueOnce(durableAnswer(JSON.stringify({ todoId: final })));
    const sent = f.send(
      "Get prototypes for Cake-set needs attention in a to-do; I will pick one to implement",
    );
    await classified;
    const message = durableAnswer("", [
      { type: "toolCall", id: "create-task", name: "create_task", arguments: {} },
    ]);
    stream.push({ type: "done", reason: "toolUse", message });
    const settled = await sent;
    const doc = await f.finish();
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.classify.mock.calls[0]?.[1].messages)).not.toContain(
      "Prototype Cake-set needs-attention",
    );
    expect(JSON.stringify(f.classify.mock.calls[1]?.[1].messages)).toContain(
      "Prototype Cake-set needs-attention",
    );
    const expected = final === "failure" ? null : final;
    expect(doc?.inputs[String(settled.entry)]).toEqual({ pending: false, todoId: expected });
    expect(f.reports).toHaveBeenCalledTimes(final === "failure" ? 1 : 0);
    const page = await readDurableOriginalPage(
      f.engine.root,
      undefined,
      undefined,
      undefined,
      undefined,
      doc?.inputs,
    );
    expect(
      page.parts.find((part) => part.kind === "text" && part.entryId === String(settled.entry)),
    ).toMatchObject({ taskTodoId: expected });
  },
);

it("repairs historical grouping through a scoped operation, persists it, and never rewrites originals or to-dos", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-task-repair-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "chat.sqlite");
  const f = await fixture(false, database);
  const sent = await f.send("Prototype needs-attention to-dos");
  await f.finish();
  const originals = await f.engine.root.entries({}, 200, undefined, context);
  const todos = [todo(A), todo(B)];
  const registry = new CakeOperationRegistry(
    taskAttributionOperations({
      conversation: () => f.engine.root,
      todos: () => todos,
    }),
  );
  const invoke = (entryId: string, todoId: string | null) =>
    registry.invoke(
      { command: "messages.set-todo", input: { entryId, todoId } },
      { signal: new AbortController().signal, toolCallId: "repair", runtime: {} },
    );
  const entryId = String(sent.entry);
  const page = async () =>
    readDurableOriginalPage(
      f.engine.root,
      undefined,
      undefined,
      undefined,
      undefined,
      (await f.finish())?.inputs,
    );
  expect(
    (await page()).parts.find((part) => part.kind === "text" && part.entryId === entryId),
  ).toMatchObject({ taskTodoId: A });
  expect((await invoke(entryId, B)).structuredContent).toEqual({
    command: "messages.set-todo",
    result: { entryId, todoId: B },
  });
  expect(
    (await page()).parts.find((part) => part.kind === "text" && part.entryId === entryId),
  ).toMatchObject({ taskTodoId: B });
  await expect(invoke(entryId, "00000000-0000-4000-8000-000000000099")).rejects.toThrow(
    "not in this chat",
  );
  const assistant = originals.items.find((entry) => entry.kind === "pi.assistant");
  if (!assistant) throw new Error("Missing assistant original");
  await expect(invoke(String(assistant.id), B)).rejects.toThrow("settled human-turn");
  await expect(invoke("9007199254740992", B)).rejects.toThrow("Invalid original");
  await invoke(entryId, null);
  expect(
    (await page()).parts.find((part) => part.kind === "text" && part.entryId === entryId),
  ).toMatchObject({ taskTodoId: null });
  await invoke(entryId, B);
  expect(
    (await f.engine.root.entries({}, 200, undefined, context)).items.filter((entry) =>
      entry.kind.startsWith("pi."),
    ),
  ).toEqual(originals.items.filter((entry) => entry.kind.startsWith("pi.")));
  expect(todos).toEqual([todo(A), todo(B)]);
  await f.engine.close();
  const reopened = await fixture(false, database);
  expect((await reopened.finish())?.inputs[entryId]).toEqual({ pending: false, todoId: B });
  expect(reopened.classify).not.toHaveBeenCalled();
});

it("rejects repair while attribution is still pending", async () => {
  const f = await fixture();
  let release = () => {};
  const decision = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.classify.mockImplementationOnce(async () => {
    await decision;
    return durableAnswer(JSON.stringify({ todoId: A }));
  });
  const sent = await f.send("Discuss startup");
  const registry = new CakeOperationRegistry(
    taskAttributionOperations({
      conversation: () => f.engine.root,
      todos: () => [todo(A), todo(B)],
    }),
  );
  try {
    await expect(
      registry.invoke(
        { command: "messages.set-todo", input: { entryId: String(sent.entry), todoId: B } },
        { signal: new AbortController().signal, toolCallId: "repair", runtime: {} },
      ),
    ).rejects.toThrow("settled human-turn");
  } finally {
    release();
    await f.finish();
  }
});

it.each(["not JSON", JSON.stringify({ todoId: "00000000-0000-4000-8000-000000000099" })])(
  "leaves invalid/unknown attribution ungrouped and still accounts for its model usage (%s)",
  async (output) => {
    const f = await fixture();
    const reply = durableAnswer(output);
    reply.usage.input = 7;
    reply.usage.totalTokens = 7;
    f.classify.mockResolvedValueOnce(reply);
    const settled = await f.send("Startup please");
    const doc = await f.finish();
    expect(doc?.inputs[String(settled.entry)]).toEqual({ todoId: null, pending: false });
    expect(f.reports).toHaveBeenCalled();
    const usage = await f.engine.harness.snapshot(UsageDoc, f.engine.root.id, context);
    expect(usage?.models["utility-provider/fast-utility"]?.input).toBe(7);
  },
);

it("classifies selected to-dos as evidence even for short follow-ups and explicit switches", async () => {
  const f = await fixture();
  for (const [text, decision] of [
    ["Yes, check that too", A],
    ["Switch to navigation instead", B],
  ] as const) {
    f.classify.mockResolvedValueOnce(durableAnswer(JSON.stringify({ todoId: decision })));
    const reminder =
      "<system-reminder>\nProject Chat user changes. Context only.\n" +
      JSON.stringify({ selection: todo(A), changes: [] }) +
      "\n</system-reminder>\n\n";
    const settled = await f.send(text, {
      _tag: "UserWithReminders",
      text: reminder + text,
      userText: text,
      notices: [],
    });
    const doc = await f.finish();
    expect(doc?.inputs[String(settled.entry)]?.todoId).toBe(decision);
  }
  expect(f.classify).toHaveBeenCalledTimes(2);
  for (const call of f.classify.mock.calls) {
    const content = call[1].messages[1]?.content;
    if (typeof content !== "string") throw new Error("Expected classifier JSON");
    const payload = JSON.parse(content);
    expect(payload.messages.at(-1).selectedTask).toContain("Startup investigation");
    expect(payload.messages.at(-1).text).not.toContain("system-reminder");
  }
});

it("starts attribution before the conversation produces its first answer", async () => {
  const f = await fixture();
  const stream = createAssistantMessageEventStream();
  vi.mocked(f.models.streamSimple).mockReturnValueOnce(stream);
  let started = () => {};
  const classified = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.classify.mockImplementationOnce(async () => {
    started();
    return durableAnswer(JSON.stringify({ todoId: A }));
  });
  let answered = false;
  const sent = f.send("Check startup").then((result) => {
    answered = true;
    return result;
  });
  await classified;
  expect(answered).toBe(false);
  const message = durableAnswer("Main answer");
  stream.push({ type: "done", reason: "stop", message });
  await sent;
  await f.finish();
});

it("sends bounded recent dialogue and candidate metadata with a stable instruction prefix", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) {
    await f.send(`Startup follow-up ${i}: ` + "x".repeat(5000));
    await f.finish();
  }
  const first = f.classify.mock.calls[0]?.[1].messages;
  const last = f.classify.mock.calls.at(-1)?.[1].messages;
  expect(last?.[0]).toEqual(first?.[0]);
  const content = last?.[1]?.content;
  if (typeof content !== "string") throw new Error("Expected classifier JSON");
  const payload = JSON.parse(content);
  expect(payload.messages).toHaveLength(6);
  expect(payload.messages.every((message: { text: string }) => message.text.length <= 1600)).toBe(
    true,
  );
  expect(payload.messages.at(-1).text).toContain("Startup follow-up 3");
  expect(payload.messages.map((message: { text: string }) => message.text).join(" ")).not.toContain(
    "Startup follow-up 0",
  );
  expect(payload.todos.map((item: { id: string }) => item.id)).toEqual([A, B]);
  expect(payload.todos[0]).toEqual({
    id: A,
    title: "Startup investigation",
    description: "Current work",
    state: "open",
  });
});

it.each(["missing", "unavailable", "failed"] as const)(
  "reports %s utility configuration/provider failures without blocking or falling back",
  async (failure) => {
    const f = await fixture();
    if (failure === "missing") f.utilityModel.mockReturnValue(undefined);
    if (failure === "unavailable")
      vi.mocked(f.models.getModel).mockImplementation((provider) =>
        provider === f.utility.provider ? undefined : durableModel,
      );
    if (failure === "failed") f.classify.mockRejectedValueOnce(new Error("Provider offline"));
    const settled = await f.send("Startup please");
    const doc = await f.finish();
    expect(doc?.inputs[String(settled.entry)]).toEqual({ pending: false, todoId: null });
    expect(f.classify).toHaveBeenCalledTimes(failure === "failed" ? 1 : 0);
    expect(f.reports.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          failure === "missing"
            ? "Configure a utility model"
            : failure === "unavailable"
              ? "Configured utility model"
              : "Provider offline",
        ),
      }),
    );
    expect(f.requests).toHaveLength(1);
  },
);

it("does not install attribution outside permanent chats supplying a to-do scope", async () => {
  const f = await fixture(false, undefined, false);
  await f.send("Startup please");
  expect(await f.finish()).toBeUndefined();
  expect(f.classify).not.toHaveBeenCalled();
});
