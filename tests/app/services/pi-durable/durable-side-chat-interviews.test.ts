import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-durable-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cakeChatSideChatSessionId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import type { InterviewRecord } from "../../../../src/contracts/interviews/interview";
import { createCakeInterviewOperations } from "../../../../src/domain/interviews/cake-interview-operations";
import {
  readDurableActiveInterviews,
  readDurableActiveTools,
  readDurableOriginalPage,
} from "../../../../src/services/pi-durable/durable-chat-history";
import { createDurableSideChatInterview } from "../../../../src/services/pi-durable/durable-side-chat-interviews";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each([false, true])(
  "persists exact native fork interview metadata before requesting input and retains response/cancel through reopen (cancel=%s)",
  async (cancel) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-durable-interview-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "chat.sqlite");
    const entered = Promise.withResolvers<InterviewRecord>();
    const response = Promise.withResolvers<{ choice: string } | undefined>();
    const request = {
      protocol: "cake.request/v1",
      id: "side-question",
      title: "Choose a direction",
      responseSchema: { type: "object", properties: { choice: { type: "string" } } },
      view: { type: "form", fields: [{ id: "choice", label: "Choice", type: "text" }] },
      fallback: { markdown: "Choose a direction." },
    };
    const registry = createRegistry();
    const tool = defineTool({
      name: "cake",
      description: "Cake controls",
      parameters: Type.Object({
        command: Type.String(),
        input: Type.Object({ request: Type.Any() }),
      }),
      replay: "unsafe",
      async execute(input, api, toolContext) {
        if (api.conversationId !== side.id) throw new Error("Not an open side chat");
        const dispatch = createDurableSideChatInterview(
          cakeChatSideChatSessionId(side.id),
          (bridge) =>
            createCakeInterviewOperations(bridge.host, {
              async requestInterview(record) {
                await bridge.publishSnapshot();
                entered.resolve(record);
                return response.promise;
              },
            }),
        );
        return dispatch(input, api, toolContext);
      },
    });
    registry.install(defineExtension({ name: "cake", tools: [tool] }));
    const models = durableModels((_request, index) =>
      index === 2
        ? durableAnswer("", [
            {
              type: "toolCall",
              id: "side-interview-call",
              name: "cake",
              arguments: { command: "interview.open", input: { request } },
            },
          ])
        : durableAnswer("Done"),
    ).models;
    const open = async () => {
      const harness = await Harness.open(
        await openNodeSqliteStorage(database),
        { models, registry },
        context,
      );
      cleanup.push(() => harness.close(context));
      return harness;
    };
    const harness = await open();
    const root = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "fixture" }, tools: [tool] },
    });
    const seed = await (
      await root.submit({ type: "input", content: "Parent" }, context)
    ).wait(context);
    if (seed.status !== "done" || seed.type !== "input") throw new Error("Seed failed");
    const parent = await readDurableOriginalPage(root);
    const side = await root.fork(seed.answer, { ownership: { kind: "ownerless" } }, context);
    const fork = side;
    const submission = await fork.submit({ type: "input", content: "Ask me here" }, context);
    const record = await Promise.race([
      entered.promise,
      submission.wait(context).then(async () => {
        throw new Error(JSON.stringify((await readDurableOriginalPage(fork)).parts));
      }),
    ]);
    expect(record.sessionId).toBe(cakeChatSideChatSessionId(side.id));
    expect(record.id).toBe("side-interview-call");
    const live = await harness.snapshot(LiveDoc, side.id, context);
    expect(live?.tools?.[0]?.details).toMatchObject({ interview: { ...record } });
    const history = (conversation: Conversation) =>
      conversation.commit(
        async (tx) =>
          readDurableOriginalPage(
            {
              entries: (query, limit, cursor) =>
                tx.scanEntries({ ...query, conversationId: conversation.id }, limit, cursor),
            },
            undefined,
            await readDurableActiveTools(tx, conversation.id),
            undefined,
            await readDurableActiveInterviews(tx, conversation.id),
          ),
        context,
      );
    const waiting = (await history(side)).parts.find((part) => part.kind === "tool");
    expect(waiting).toMatchObject({ state: "running", interview: record });
    expect(await readDurableOriginalPage(root)).toEqual(parent);
    response.resolve(cancel ? undefined : { choice: "Left" });
    expect(await submission.wait(context)).toMatchObject({ status: "done" });
    const settled = await history(side);
    expect(settled.parts.find((part) => part.kind === "tool")).toMatchObject({
      interview: record,
      interviewResult: cancel
        ? { interviewId: record.id, cancelled: true }
        : { interviewId: record.id, cancelled: false, value: { choice: "Left" } },
    });
    const sideId = side.id;
    await harness.close(context);
    const reopened = await open();
    const restored = await reopened.conversation(sideId, context);
    if (!restored) throw new Error("Missing fork");
    expect((await history(restored)).parts).toEqual(settled.parts);
  },
);
