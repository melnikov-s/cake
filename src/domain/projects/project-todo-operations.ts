import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  ProjectTodo,
  ProjectTodoListInput,
  ProjectTodoList,
  ProjectTodoDetail,
  ProjectTodoCreate,
  ProjectTodoUpdate,
  ProjectTodoUpdates,
  ProjectTodoReceipt,
  ProjectTodoSnooze,
  ProjectTodoUnsnooze,
  ProjectTodoSelection,
  PROJECT_TODO_AUTO_COMPLETION_RULE,
  PROJECT_TODO_CLOSING_RULE,
  PROJECT_TODO_CREATION_RULE,
  PROJECT_TODO_DESCRIPTION_GUIDANCE,
  PROJECT_TODO_LINK_GUIDANCE,
  PROJECT_TODO_ATTENTION_GUIDANCE,
  projectTodoCompletionSummary,
  type ProjectTodoControl,
} from "../../contracts/projects/project-todos";

export function createProjectTodoOperations(
  control: ProjectTodoControl,
): CakeOperationDefinition[] {
  const guidance = [
    `${PROJECT_TODO_AUTO_COMPLETION_RULE} Run sessions.resolve, then edit only title/description/status if needed.`,
    `${PROJECT_TODO_CREATION_RULE} No polling/wakes merely for open items.`,
    "Default list is title/id/state/revision, needsAttention and retained attentionReason, plus snoozedUntil when snoozed. Filter category=attention|active|snoozed|done; state=open includes Needs attention, Active and Snoozed. For reconciliation use ONE todos.list with state=open, view=reconciliation (max 50), then ONE todos.update-many with expectedRevision per item. Page with nextOffset. No transcript reads or per-session inspection needed.",
    "Reconciliation sessions contain canonical required session IDs and authoritative effective resolved (null means unknown), not execution done/stopped. All actual session associations must resolve before automatic closure, including historical items and late associations. Source/report links are context: they never veto completion and source-only discussion items remain open. Reports/run completion never close items.",
    `${PROJECT_TODO_CLOSING_RULE} Restore never reopens items. Explicit user done is preserved. Agent to-do edits never resolve/restore, stop, delete or merge sessions. Human Mark done resolves required linked sessions first and exposes blockers without claiming Done. Cake reconciles linked Open items automatically; no assistant update, report acknowledgment, polling or wake is required.`,
    "Use remainingWork for implementation/review still to do after current sessions resolve; null clears a satisfied handoff. This holds automatic closure, not explicit human Mark done. Never close then reopen for phase changes. Read details by ID only when needed. Pass expectedRevision; on revision conflict reread; preserve explicit user closure/reopen. state=done on an already-done item is a no-op for state: alone it commits nothing; other edits still apply, including when the only change since your revision was that completion (for example by sessions.resolve). The receipt note says why it was already done; any other intervening change is a conflict. Association updates replace the complete merged list. Mutations return compact committed receipts; detail=true opts into content.",
    "Only on a user compaction request, collect the requested items’ session associations (including session IDs in cake://session source/message/report links) and use sessions.compact-batch. Report unlinked items and per-session outcomes. Agent Done is not session resolution; no to-do completion automatically triggers compaction.",
  ] as const;
  const detail = Schema.optionalKey(Schema.Boolean);
  // Was the item already done before this call? It was completed by this call only if an
  // agent completed it exactly at the next revision.
  const alreadyDoneNote = (
    item: ProjectTodo,
    input: Partial<ProjectTodoUpdate>,
  ): { note: string } | undefined => {
    if (input.state !== "done" || item.state !== "done" || input.expectedRevision === undefined)
      return undefined;
    if (item.completion?.by === "agent" && item.completion.revision === input.expectedRevision + 1)
      return undefined;
    const why = projectTodoCompletionSummary(item);
    const edits = [
      input.title,
      input.description,
      input.status,
      input.remainingWork,
      input.associations,
      input.needsAttention,
      input.attentionReason,
      input.snoozedUntil,
    ].some((value) => value !== undefined);
    return {
      note: edits
        ? `Already done (${why}); state unchanged and your other edits were applied.`
        : `Already done (${why}); nothing changed.`,
    };
  };
  const receipt = async (
    item: ProjectTodo,
    input: Partial<ProjectTodoUpdate>,
    includeDetail: boolean | undefined,
    signal: AbortSignal,
    created = false,
  ) => ({
    ...(created ? { id: item.id } : null),
    revision: item.revision,
    committed: true as const,
    needsAttention: Boolean(item.needsAttention),
    ...(item.attentionReason ? { attentionReason: item.attentionReason } : null),
    ...(input.snoozedUntil !== undefined ? { snoozedUntil: item.snoozedUntil ?? null } : null),
    ...(input.state === undefined &&
    item.state === "done" &&
    (created || input.associations !== undefined || input.snoozedUntil !== undefined)
      ? { state: item.state }
      : null),
    ...(input.associations &&
    JSON.stringify(input.associations) !== JSON.stringify(item.associations)
      ? { associations: item.associations }
      : null),
    ...(alreadyDoneNote(item, input) ?? null),
    ...(includeDetail ? { detail: await control.read(item.id, signal) } : null),
  });
  return [
    {
      command: "todos.select",
      topic: "todos",
      summary: "Focus/clear transcript to-do",
      guidance: [
        "Pass an active to-do ID in this chat's list, or null to deselect without choosing a replacement. Selecting the same ID is idempotent, not a toggle. Only explicit selection chooses an item; completion and snoozing clear it without replacement.",
        "Focus only changes the transcript view while the panel is open. It never attaches context to a message, changes transcript attribution or needs attention, or starts/resolves work. Reply to a to-do from the UI to attach it to the next message.",
      ],
      inputSchema: ProjectTodoSelection,
      outputSchema: ProjectTodoSelection,
      examples: [
        { input: { selectedId: "00000000-0000-4000-8000-000000000001" } },
        { input: { selectedId: null } },
      ],
      result: "Persisted selectedId, or null; no automatic replacement.",
      execute: async (input, context) =>
        control.select(
          await Schema.decodeUnknownPromise(ProjectTodoSelection)(input),
          context.signal,
        ),
    },
    {
      command: "todos.list",
      topic: "todos",
      summary: "List to-dos/lifecycle",
      guidance: [guidance[2], guidance[3]],
      inputSchema: ProjectTodoListInput,
      outputSchema: ProjectTodoList,
      examples: [{ input: {} }, { input: { state: "open", view: "reconciliation", limit: 50 } }],
      result:
        "Bounded id/title/state/revision rows with attention flag/retained reason and pagination; reconciliation adds required work session lifecycle only.",
      execute: async (input, context) =>
        control.list(
          await Schema.decodeUnknownPromise(ProjectTodoListInput)(input),
          context.signal,
        ),
    },
    {
      command: "todos.read",
      topic: "todos",
      summary: "Read to-do details",
      guidance: [
        "Exact details by ID; use todos.list for cheap discovery and reconciliation.",
        guidance[6],
      ],
      inputSchema: Schema.Struct({ id: ProjectTodo.fields.id }),
      outputSchema: ProjectTodoDetail,
      examples: [{ input: { id: "00000000-0000-4000-8000-000000000001" } }],
      result:
        "Exact description/status/attention/links/revision and canonical work session IDs with effective resolution.",
      async execute(input, context) {
        const { id } = await Schema.decodeUnknownPromise(
          Schema.Struct({ id: ProjectTodo.fields.id }),
        )(input);
        return control.read(id, context.signal);
      },
    },
    {
      command: "todos.create",
      topic: "todos",
      summary: "Track ongoing work",
      guidance: [
        guidance[1],
        PROJECT_TODO_ATTENTION_GUIDANCE,
        PROJECT_TODO_DESCRIPTION_GUIDANCE,
        PROJECT_TODO_LINK_GUIDANCE,
        "Already-resolved associated session work closes on creation. Source-only review threads remain open. Returns new id/revision; detail=true opts into content.",
      ],
      inputSchema: Schema.Struct({ ...ProjectTodoCreate.fields, detail }),
      outputSchema: ProjectTodoReceipt,
      examples: [
        {
          input: {
            title: "Investigate startup",
            description: "Startup investigation is underway. No findings reported yet.",
            needsAttention: false,
          },
        },
      ],
      result: "Committed new id/revision; detail only when requested.",
      async execute(input, context) {
        const parsed = await Schema.decodeUnknownPromise(
          Schema.Struct({ ...ProjectTodoCreate.fields, detail }),
        )(input);
        return receipt(
          await control.create(parsed, context.signal),
          parsed,
          parsed.detail,
          context.signal,
          true,
        );
      },
    },
    {
      command: "todos.update",
      topic: "todos",
      summary: "Edit to-do with revision check",
      guidance: [
        guidance[0],
        guidance[4],
        guidance[5],
        PROJECT_TODO_ATTENTION_GUIDANCE,
        PROJECT_TODO_DESCRIPTION_GUIDANCE,
        PROJECT_TODO_LINK_GUIDANCE,
      ],
      inputSchema: Schema.Struct({ ...ProjectTodoUpdate.fields, detail }),
      outputSchema: ProjectTodoReceipt,
      examples: [
        {
          input: { id: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, state: "done" },
        },
      ],
      result:
        "Compact committed new revision, plus canonicalized or unexpected changes. Stale updates fail.",
      async execute(input, context) {
        const parsed = await Schema.decodeUnknownPromise(
          Schema.Struct({ ...ProjectTodoUpdate.fields, detail }),
        )(input);
        return receipt(
          await control.update(parsed, context.signal),
          parsed,
          parsed.detail,
          context.signal,
        );
      },
    },
    {
      command: "todos.snooze",
      topic: "todos",
      summary: "Hide until future UTC time",
      guidance: [
        "Pass id, expectedRevision and until as a valid future UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ). Read the current revision first. Calling again replaces the deadline. Only open items can be snoozed; this never reopens done items.",
        "Snooze changes visibility only, retains attention and expires across restart. No paused execution/reminder/wake. Linked session resolution still completes items.",
      ],
      inputSchema: ProjectTodoSnooze,
      outputSchema: ProjectTodoReceipt,
      examples: [
        {
          input: {
            id: "00000000-0000-4000-8000-000000000001",
            expectedRevision: 0,
            until: "2030-01-01T12:00:00.000Z",
          },
        },
      ],
      result:
        "Committed revision and canonical snoozedUntil, or null if linked resolution completed the item.",
      async execute(input, context) {
        const parsed = await Schema.decodeUnknownPromise(ProjectTodoSnooze)(input);
        const update = {
          id: parsed.id,
          expectedRevision: parsed.expectedRevision,
          snoozedUntil: parsed.until,
        };
        return receipt(await control.update(update, context.signal), update, false, context.signal);
      },
    },
    {
      command: "todos.unsnooze",
      topic: "todos",
      summary: "End snooze",
      guidance: [
        "Pass id and current expectedRevision. Clears the deadline, including before it expires. Done items remain done; this never reopens them or starts any work. No reminder or session wakeup is sent.",
      ],
      inputSchema: ProjectTodoUnsnooze,
      outputSchema: ProjectTodoReceipt,
      examples: [{ input: { id: "00000000-0000-4000-8000-000000000001", expectedRevision: 1 } }],
      result: "Committed revision with snoozedUntil=null; completion state is preserved.",
      async execute(input, context) {
        const parsed = await Schema.decodeUnknownPromise(ProjectTodoUnsnooze)(input);
        const update = { ...parsed, snoozedUntil: null };
        return receipt(await control.update(update, context.signal), update, false, context.signal);
      },
    },
    {
      command: "todos.update-many",
      topic: "todos",
      summary: "Edit up to 50 atomically",
      guidance: [
        "Use one todos.list view=reconciliation read, then this call. Every update requires expectedRevision. All-or-none; stale errors identify the conflict/current revision. Receipts follow input order without echoing IDs.",
        guidance[0],
        PROJECT_TODO_ATTENTION_GUIDANCE,
        PROJECT_TODO_DESCRIPTION_GUIDANCE,
        PROJECT_TODO_LINK_GUIDANCE,
        "All linked sessions resolved closes items. Already-done state is a no-op; restore never reopens; agent to-do edits never resolve sessions. Human Mark done resolves required linked sessions first.",
      ],
      inputSchema: Schema.Struct({ updates: ProjectTodoUpdates }),
      outputSchema: Schema.Struct({ receipts: Schema.Array(ProjectTodoReceipt) }),
      examples: [
        {
          input: {
            updates: [
              { id: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, state: "done" },
            ],
          },
        },
      ],
      result:
        "Compact ordered per-item committed new revision receipts. All-or-none, never partial success.",
      async execute(input, context) {
        const { updates } = await Schema.decodeUnknownPromise(
          Schema.Struct({ updates: ProjectTodoUpdates }),
        )(input);
        const items = await control.updateMany(updates, context.signal);
        return {
          receipts: await Promise.all(
            items.map((item) =>
              receipt(
                item,
                updates.find((update) => update.id === item.id) ?? {},
                false,
                context.signal,
              ),
            ),
          ),
        };
      },
    },
  ];
}
