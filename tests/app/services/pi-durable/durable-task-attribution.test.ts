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
import { Type } from "@earendil-works/pi-durable-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { TaskAttributionDoc } from "../../../../src/services/pi-durable/durable-task-attribution";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import type { ProjectTodo } from "../../../../src/contracts/projects/project-todos";
import type { InternalInput } from "../../../../src/contracts/conversations/internal-input";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

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

async function fixture(withTool = false, database?: string) {
  const f = durableModels((_request, index) =>
    withTool && index === 1
      ? durableAnswer("", [
          { type: "toolCall", id: "create-task", name: "create_task", arguments: {} },
        ])
      : durableAnswer("Normal streamed answer"),
  );
  let items = withTool ? [] : [todo(A), todo(B)];
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
      items = [todo(A)];
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
    todos: () => items,
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
  return { ...f, engine, classify, send, finish, reports };
}

it("runs once per consumed input, reuses the conversational model, and projects A → A → B → A → none without rewriting originals", async () => {
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
    "What does Command K do?",
  ]) {
    const settled = await f.send(text);
    inputs.push(String(settled.entry));
    await f.finish();
  }
  expect(f.classify).toHaveBeenCalledTimes(5);
  const doc = await f.finish();
  expect(inputs.map((id) => doc?.inputs[id]?.todoId)).toEqual(decisions);
  expect(f.classify.mock.calls[0]?.[0]).toMatchObject({ provider: "fixture", id: "fixture" });
  expect(f.classify.mock.calls[0]?.[2]).toMatchObject({
    maxTokens: 256,
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

it("sees a task created by the initial tool round without issuing a second attribution request", async () => {
  const f = await fixture(true);
  await f.send("Investigate startup");
  await f.finish();
  expect(f.requests).toHaveLength(2);
  expect(f.classify).toHaveBeenCalledTimes(1);
  const wire = f.classify.mock.calls[0]?.[1].messages;
  expect(JSON.stringify(wire)).toContain("Startup investigation");
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
    expect(usage?.models["fixture/fixture"]?.input).toBe(7);
  },
);
