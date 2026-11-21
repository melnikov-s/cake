import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS } from "../../contracts/cake-chats/cake-chat-preferences";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import { acpPrompt } from "../antigravity/acp";
import { cakePortableInstructions } from "../pi/runtime/cake-instructions";
import { createAntigravityTurnController } from "../pi/runtime/antigravity-transcript";
import { splitContextReminders } from "../pi/runtime/session-context-reminders";
import { parseContextAttachmentBlocks } from "../pi/runtime/user-message-transport";
import {
  AntigravityReplyEntry,
  AntigravityUserEntry,
  durableAntigravityOriginal,
} from "./durable-antigravity-entries";
import type { openDurableChatEngine } from "./durable-chat-engine";
import { createDurableChatMemory } from "./durable-chat-memory";
import { durableInputPresentation } from "./durable-input-presentation";
import type { projectChatAntigravityCake } from "./durable-antigravity-cake";

// Existing Pi OptMem nodes may have already blended tools, session updates and
// imported history into prose. Never export them or try to redact them afterward.
// Select from a separate *derived* OptMem view of this root's vetted originals.
function antigravityMemorySource(entry: EntryRecord) {
  // An external reply may quote data from a one-time approved Cake call.
  // An approval is not consent to re-export it as memory on another turn.
  if (AntigravityReplyEntry.is(entry) && entry.data.cakeDataAccessed) return "";
  const external = durableAntigravityOriginal(entry);
  if (external)
    return external.text.trim() ? `${external.role} (Antigravity turn): ${external.text}` : "";
  if (entry.kind !== "pi.user") return "";
  return (entry.model ?? [])
    .flatMap((message) => {
      if (message.role !== "user") return [];
      const raw =
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");
      const input = durableInputPresentation(raw);
      if (input.responseMode === undefined || input.subagentReport) return [];
      // Only the exact human-authored portion of reminder-bearing admissions.
      // Other internal inputs (including reports and batched updates) are not dialogue.
      const text =
        input.internal === undefined
          ? input.text
          : input.internal._tag === "UserWithReminders"
            ? input.internal.userText
            : undefined;
      if (text === undefined) return [];
      const clean = parseContextAttachmentBlocks(splitContextReminders(text).text).text;
      if (
        !clean ||
        parseCrossSessionMessage(clean) ||
        parseScheduledMessage(clean) ||
        /(?:^\s*[!/]|<(?:\/?cake[-:.]|\/?system-reminder\b|skill\b))/i.test(clean)
      )
        return [];
      // Pi replies are excluded: even visible prose may quote unrelated tool
      // results or other chats, and there is no reliable origin for those quotes.
      return [`user (Pi turn): ${clean}`];
    })
    .join("\n");
}

export function createDurableAntigravity(options: {
  engine: Awaited<ReturnType<typeof openDurableChatEngine>>;
  sessionId: string;
  cwd: string;
  cake: ReturnType<typeof projectChatAntigravityCake>;
  budget(): number;
  contextLimit(): number | undefined;
  beforeInput(): Promise<() => void>;
  onChanged(): void;
}) {
  const { engine, sessionId, cwd } = options;
  const { harness, root, storage } = engine;
  const memory = createDurableChatMemory(
    harness,
    root,
    storage,
    {
      budget: options.budget,
      summarize: () => {
        throw new Error("Antigravity's memory view is local and extractive");
      },
    },
    antigravityMemorySource,
  );
  let before: EntryId | undefined;
  let cakeDataAccessed = false;
  const instructions = [cakePortableInstructions("project-chat"), options.cake.instructions].join(
    "\n\n",
  );
  return createAntigravityTurnController({
    cwd,
    sessionId: () => sessionId,
    scope: "project-chat",
    onChanged: options.onChanged,
    async admit(request) {
      cakeDataAccessed = false;
      const assertCurrent = await options.beforeInput();
      await root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, root.id);
        const inbox = await tx.doc(InboxDoc, root.id);
        if (live.run || live.compactions?.length || inbox.items.length || engine.isCompacting())
          throw new Error(
            "Wait for the current work and queued messages to finish before using Antigravity.",
          );
        before = (await tx.scanEntries({ conversationId: root.id, order: "descending" }, 1))
          .items[0]?.id;
        assertCurrent();
        await tx.appendEntry(AntigravityUserEntry, root.id, {
          data: { markdown: request.markdown },
          model: [{ role: "user", content: request.text, timestamp: Date.now() }],
        });
      }, BACKGROUND_CONTEXT);
    },
    async prepare({ text, permission }, signal) {
      const cakeCall = options.cake.forTurn(permission, () => {
        cakeDataAccessed = true;
      });
      // UTF-8 frame bytes are conservatively counted against the configured
      // token cap. The adapter checks the exact serialized frame with its real
      // ACP session id. Fit the history after reserving the complete user text,
      // Cake instructions, wrappers and worst-case escaping of history quotes.
      const maxPromptBytes = options.contextLimit() ?? DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS;
      const fixed = Buffer.byteLength(
        JSON.stringify(
          acpPrompt({
            text,
            instructions,
            history: " ",
          }),
        ),
      );
      const budget = Math.min(options.budget(), Math.floor((maxPromptBytes - fixed - 256) / 2));
      if (fixed + 128 > maxPromptBytes)
        throw new Error(
          "The current message and Cake instructions cannot fit the Antigravity context limit. Shorten the message.",
        );
      const prepared = { maxPromptBytes, instructions, cakeCall };
      if (before === undefined || budget < 1024) return prepared;
      const view = await memory.synchronize(signal, before, budget);
      if (!view.complete)
        throw new Error("Could not prepare bounded Project Chat memory for Antigravity.");
      return { ...prepared, history: view.text || undefined };
    },
    async persist(details, content) {
      await root.commit(async (tx) => {
        await tx.appendEntry(AntigravityReplyEntry, root.id, {
          data: {
            ...details,
            segments: [...details.segments],
            ...(cakeDataAccessed ? { cakeDataAccessed: true } : null),
          },
          model: [{ role: "user", content, timestamp: Date.now() }],
        });
      }, BACKGROUND_CONTEXT);
    },
  });
}
