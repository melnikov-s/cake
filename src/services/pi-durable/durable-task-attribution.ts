import {
  defineDoc,
  LiveDoc,
  type Conversation,
  type EntryId,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-durable-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Option, Schema } from "effect";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import { durableInputPresentation } from "./durable-input-presentation";
import { isAutomaticInput } from "../pi/runtime/internal-input-projection";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";

/** Identity-only presentation metadata. Originals remain the only transcript. */
export const TaskAttributionDoc = defineDoc<{
  inputs: Record<string, { pending: boolean; todoId: string | null; turnId?: string }>;
}>({
  kind: "cake.task-attribution",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ inputs: {} }),
});

export const TASK_ATTRIBUTION_INSTRUCTIONS =
  'For each current human input marked <cake-turn id="…"/>, attribute that input and your response to one open to-do from the existing injected list, or explicitly none. Follow the actual topic: related short follow-ups continue; topic switches and returns use the matching identity. Selection is evidence, not assignment. After any needed to-do creation/tools, append exactly one hidden metadata block per marked current input at the END of your final answer: <cake-todo>{"turnId":"the exact cake-turn id","todoId":"open to-do UUID or null"}</cake-todo>. Use JSON null for no matching to-do. Never use completed items, invent IDs, repeat old decisions, or write metadata in prose/code fences. No extra tool calls or model turns just for attribution.';

const Decision = Schema.Struct({
  turnId: Schema.String.check(Schema.isUUID(4)),
  todoId: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
});
const OPEN = "<cake-todo>";

/** Also withhold split opening tags and incomplete metadata on interruption. */
function visibleText(value: string): string {
  const clean = value.replace(/<cake-todo>[\s\S]*?(?:<\/cake-todo>|$)/g, "");
  for (let n = OPEN.length - 1; n > 0; n -= 1)
    if (clean.endsWith(OPEN.slice(0, n))) return clean.slice(0, -n);
  return clean;
}
const visibleMessage = (message: AssistantMessage): AssistantMessage => ({
  ...message,
  content: message.content.map((block) =>
    block.type === "text" ? { ...block, text: visibleText(block.text) } : block,
  ),
});

/** One normal provider request, no scheduler, model call, history replay or tool round. */
export async function prepareTaskAttribution(options: {
  conversation: Conversation;
  harness: Harness;
  storage: Storage;
  signal: AbortSignal;
  todos(): readonly ProjectTodo[];
}) {
  const { conversation, harness, storage } = options;
  const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
  const bound = new Map<string, EntryId>();
  for (const id of live?.run?.inputs ?? []) {
    const submission = await storage.submission(id, BACKGROUND_CONTEXT);
    if (submission?.status !== "placed") continue;
    const entry = await storage.entry(conversation.id, submission.entry, BACKGROUND_CONTEXT);
    const user = entry?.entry.model?.find((message) => message.role === "user");
    if (!user || user.role !== "user") continue;
    const text =
      typeof user.content === "string"
        ? user.content
        : user.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const input = durableInputPresentation(text);
    if (
      !input.attribution ||
      input.attribution.conversationId !== conversation.id ||
      isAutomaticInput(input.internal) ||
      input.subagentReport ||
      parseCrossSessionMessage(input.text)
    )
      continue;
    bound.set(input.attribution.turnId, submission.entry);
  }
  if (bound.size)
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(TaskAttributionDoc, conversation.id);
      for (const [turnId, entry] of bound)
        doc.inputs[String(entry)] ??= { pending: true, todoId: null, turnId };
    }, BACKGROUND_CONTEXT);
  const lengths = new Map<number, number>();
  return async (event: AssistantMessageEvent): Promise<AssistantMessageEvent> => {
    if (event.type === "done" && event.reason === "stop" && bound.size && !options.signal.aborted) {
      const decisions = new Map<string, Array<Schema.Schema.Type<typeof Decision>>>();
      for (const block of event.message.content) {
        if (block.type !== "text") continue;
        for (const match of block.text.matchAll(/<cake-todo>([\s\S]*?)<\/cake-todo>/g)) {
          const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Decision))(match[1]);
          if (Option.isNone(decoded)) continue;
          const list = decisions.get(decoded.value.turnId) ?? [];
          list.push(decoded.value);
          decisions.set(decoded.value.turnId, list);
        }
      }
      await conversation.commit(async (tx) => {
        // A stopped/replaced run cannot settle metadata, even if its provider finishes late.
        if (
          options.signal.aborted ||
          (await tx.doc(LiveDoc, conversation.id)).run?.taskId !== live?.run?.taskId
        )
          return;
        const doc = await tx.doc(TaskAttributionDoc, conversation.id);
        for (const [turnId, entry] of bound) {
          const candidates = decisions.get(turnId);
          const decision = candidates?.length === 1 ? candidates[0] : undefined;
          const current = doc.inputs[String(entry)];
          if (!decision || !current?.pending || current.turnId !== turnId) continue;
          if (
            decision.todoId !== null &&
            !options.todos().some((todo) => todo.id === decision.todoId && todo.state === "open")
          )
            continue;
          doc.inputs[String(entry)] = { pending: false, todoId: decision.todoId, turnId };
        }
      }, BACKGROUND_CONTEXT);
    }
    if (event.type === "done") return { ...event, message: visibleMessage(event.message) };
    if (event.type === "error") return { ...event, error: visibleMessage(event.error) };
    const partial = visibleMessage(event.partial);
    if (event.type === "text_delta") {
      const block = partial.content[event.contentIndex];
      const text = block?.type === "text" ? block.text : "";
      const delta = text.slice(lengths.get(event.contentIndex) ?? 0);
      lengths.set(event.contentIndex, text.length);
      return { ...event, partial, delta };
    }
    if (event.type === "text_end")
      return { ...event, partial, content: visibleText(event.content) };
    return { ...event, partial };
  };
}
