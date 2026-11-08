import { createHash, randomUUID } from "node:crypto";
import { clearCompletedProjectTodoSelection } from "../../utils/project-todo-selection";
import type { ProjectTodoContextReceipt } from "../../contracts/projects/project-todo-context";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { DateTime, Effect, Option, Schema } from "effect";
import { ProjectTodoReports } from "../../services/projects/ProjectTodoReports";
import { normalizeSessionTitle } from "../utility-work/utilityWork";
import {
  addSessionDigestReminder,
  splitSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { ApplicationState as ApplicationStateValue } from "../../contracts/application/application-data";
import {
  CAKE_CHAT_SESSION_ID,
  isProjectChatSessionId,
  isCakeChatSessionId,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import { ProjectError } from "../../contracts/projects/project-error";
import {
  CAKE_CHAT_TODO_SCOPE,
  emptyProjectTodos,
  isCakeChatTodoScope,
  todoChatForScope,
  ProjectTodoUpdates,
  type ProjectTodo,
  projectTodoReminder,
  projectTodoSessionIds,
  ProjectTodoCreate,
  projectTodoCompletionSummary,
  type ProjectTodoCompletion,
  type ProjectTodoUpdate,
  ProjectTodoUserMutation,
  type ProjectTodos,
  type ProjectTodoUserChange,
} from "../../contracts/projects/project-todos";

const error = (message: string) => new ProjectError({ operation: "projectTodos", message });
const mapError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => error(cause instanceof Error ? cause.message : String(cause))),
  );

/** Commit one revision. Entering done records who completed it at this revision; staying done
 * keeps the original record, so any later content edit makes the completion no longer latest. */
function commit(
  item: ProjectTodo,
  changes: Partial<
    Pick<
      ProjectTodo,
      | "title"
      | "description"
      | "status"
      | "state"
      | "associations"
      | "needsAttention"
      | "attentionReason"
    >
  >,
  by: ProjectTodoCompletion["by"],
  deadline: string | null | undefined = undefined,
): ProjectTodo {
  const { completion, snoozedUntil, ...rest } = item;
  const next = { ...rest, ...changes, revision: item.revision + 1 };
  // Completion and reopening never carry an active request into the new lifecycle state.
  if (next.state === "done" || item.state === "done") next.needsAttention = false;
  const until = deadline === undefined ? snoozedUntil : deadline;
  if (next.state !== "done") return until ? { ...next, snoozedUntil: until } : next;
  if (item.state === "done") return completion ? { ...next, completion } : next;
  return { ...next, completion: { revision: next.revision, by } };
}

/** The only change since the caller's read was the completion it is also asking for. */
const onlyCompletedSince = (item: ProjectTodo, expectedRevision: number) =>
  item.state === "done" &&
  item.completion?.revision === item.revision &&
  expectedRevision === item.revision - 1;

function conflict(item: ProjectTodo, input: ProjectTodoUpdate) {
  const current = `current revision ${item.revision}`;
  if (input.state === "done" && item.state === "done")
    return error(
      `Atomic update rejected: to-do ${item.id} is already done (${projectTodoCompletionSummary(item)}) and was also edited after your revision ${input.expectedRevision} (${current}); no state change is needed. Reread it before re-applying title/description/status/association edits; no items committed`,
    );
  const completed =
    item.state === "done" && item.completion && input.expectedRevision < item.completion.revision
      ? `; ${projectTodoCompletionSummary(item)} at revision ${item.completion.revision}`
      : "";
  return error(
    `Atomic update rejected: to-do ${item.id} changed (${current}${completed}); no items committed`,
  );
}

/** The stored list for a scope: a registered Project's list or global Cake Chat's own list. */
function stored(state: ApplicationStateValue, scope: string) {
  if (isCakeChatTodoScope(scope)) return state.cakeChatTodos ?? emptyProjectTodos();
  return state.projects.find((item) => item.path === scope)?.todos;
}

/** Source/report links are citations, not ownership. Permanent/side chats and subagents
 * retain their existing many-to-many representation. Old suffixes conservatively reserve
 * matching canonical identities too; never guess which historical task should lose a link. */
const ownedSessions = (item: ProjectTodo) =>
  projectTodoSessionIds(item).filter(
    (id) => !isCakeChatSessionId(id) && !cakeChatSideChatParentId(id),
  );
const sameSession = (a: string, b: string) => {
  const match = resolveSessionReference(a, [b]);
  const reverse = resolveSessionReference(b, [a]);
  return (match.ok && match.sessionId === b) || (reverse.ok && reverse.sessionId === a);
};
function owners(state: ApplicationStateValue, sessionId: string) {
  const lists = [
    { scope: CAKE_CHAT_TODO_SCOPE, todos: state.cakeChatTodos },
    ...state.projects.map((project) => ({ scope: project.path, todos: project.todos })),
  ];
  return lists.flatMap(({ scope, todos }) =>
    (todos?.items ?? []).flatMap((item) =>
      ownedSessions(item).some((id) => sameSession(id, sessionId)) ? [{ scope, item }] : [],
    ),
  );
}
const ownershipError = (sessionId: string, existing: ReturnType<typeof owners>) =>
  error(
    `Project Session ${sessionId} already belongs to ${existing
      .map(({ scope, item }) => `to-do ${item.id} (${JSON.stringify(item.title)}, scope ${scope})`)
      .join(
        "; ",
      )}. Read/update the existing to-do in its scope instead; no items committed. Historical duplicates require an explicit choice of owner before linking new work.`,
  );

/** Grandfather saved duplicate links, not new ones. Validate the final batch so deliberate
 * atomic transfers are possible. Unrelated edits/completion never make legacy data unloadable. */
const validateOwnership = Effect.fn("ProjectTodos.validateOwnership")(function* (
  current: ApplicationStateValue,
  scope: string,
  previous: ProjectTodos,
  updated: ProjectTodos,
) {
  const finalState = isCakeChatTodoScope(scope)
    ? { ...current, cakeChatTodos: updated }
    : {
        ...current,
        projects: current.projects.map((project) =>
          project.path === scope ? { ...project, todos: updated } : project,
        ),
      };
  for (const item of updated.items) {
    const old = previous.items.find((candidate) => candidate.id === item.id);
    for (const sessionId of ownedSessions(item)) {
      if (old && ownedSessions(old).includes(sessionId)) continue;
      const existing = owners(finalState, sessionId).filter(
        (owner) => owner.scope !== scope || owner.item.id !== item.id,
      );
      if (existing.length) return yield* ownershipError(sessionId, existing);
    }
  }
});

/** All edits serialize against the existing ApplicationStorage authority; no parallel queue/file.
 * `scope` is a registered Project path or CAKE_CHAT_TODO_SCOPE for global Cake Chat. */
const change = Effect.fn("ProjectTodos.change")(function* (
  scope: string,
  transition: (
    todos: ProjectTodos,
    current: ApplicationStateValue,
  ) => Effect.Effect<ProjectTodos, ProjectError>,
) {
  const application = yield* ApplicationState;
  const next = yield* application
    .transact((current) =>
      Effect.gen(function* () {
        const global = isCakeChatTodoScope(scope);
        if (!global && !current.projects.some((item) => item.path === scope))
          return yield* error("Unknown registered project");
        const previous = stored(current, scope) ?? emptyProjectTodos();
        const updated = yield* transition(previous, current);
        yield* validateOwnership(current, scope, previous, updated);
        const modifiedAt = DateTime.formatIso(yield* DateTime.now);
        const revisions = new Map(previous.items.map((item) => [item.id, item.revision]));
        const todos = clearCompletedProjectTodoSelection({
          ...updated,
          items: updated.items.map((item) =>
            revisions.get(item.id) === item.revision
              ? item
              : {
                  ...item,
                  ...(!revisions.has(item.id) ? { createdAt: modifiedAt } : null),
                  modifiedAt,
                },
          ),
        });
        return global
          ? { ...current, cakeChatTodos: todos }
          : {
              ...current,
              projects: current.projects.map((item) =>
                item.path === scope ? { ...item, todos } : item,
              ),
            };
      }),
    )
    .pipe(mapError);
  return stored(next, scope) ?? emptyProjectTodos();
});

/** Backend-only deadline transition. Recheck inside the serialized transaction: a later
 * deadline, manual unsnooze or completion wins over an earlier expiry snapshot. No reminder
 * or input is enqueued; publication alone returns the item to Active in every window. */
export const expireOverdue = Effect.fn("ProjectTodos.expireOverdue")(function* () {
  const application = yield* ApplicationState;
  const state = application.snapshot();
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const scopes = [...state.projects.map((project) => project.path), CAKE_CHAT_TODO_SCOPE];
  const due = (item: ProjectTodo, at: number) =>
    item.state === "open" &&
    item.snoozedUntil !== undefined &&
    DateTime.toEpochMillis(DateTime.makeUnsafe(item.snoozedUntil)) <= at;
  const expiredScopes: string[] = [];
  for (const scope of scopes) {
    if (!stored(state, scope)?.items.some((item) => due(item, now))) continue;
    yield* change(scope, (value) =>
      Effect.gen(function* () {
        const at = DateTime.toEpochMillis(yield* DateTime.now);
        return {
          ...value,
          items: value.items.map((item) =>
            due(item, at) ? commit(item, {}, "agent", null) : item,
          ),
        };
      }),
    );
    expiredScopes.push(scope);
  }
  return expiredScopes;
});

/** Advisory background results never overwrite a newer item edit. */
export const applyReportDescription = Effect.fn("ProjectTodos.applyReportDescription")(function* (
  scope: string,
  candidate: ProjectTodo,
  description: string,
) {
  yield* change(scope, (value) =>
    Effect.succeed({
      ...value,
      items: value.items.map((item) =>
        item.id === candidate.id &&
        item.state === "open" &&
        item.revision === candidate.revision &&
        item.description !== description
          ? commit(item, { description }, "agent")
          : item,
      ),
    }),
  );
});

export const list = Effect.fn("ProjectTodos.list")(function* (scope: string) {
  const application = yield* ApplicationState;
  const state = application.snapshot();
  if (!isCakeChatTodoScope(scope) && !state.projects.some((item) => item.path === scope))
    return yield* error("Unknown registered project");
  return stored(state, scope) ?? emptyProjectTodos();
});

export const read = Effect.fn("ProjectTodos.read")(function* (scope: string, id: string) {
  const item = (yield* list(scope)).items.find((item) => item.id === id);
  if (!item) return yield* error("Unknown to-do in this list");
  return item;
});

export const create = Effect.fn("ProjectTodos.create")(function* (
  scope: string,
  request: ProjectTodoCreate,
  resolved = false,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoCreate)(request).pipe(mapError);
  const item = {
    ...input,
    status: input.status ?? "",
    needsAttention: resolved ? false : (input.needsAttention ?? false),
    associations: input.associations ?? [],
    id: randomUUID(),
    state: resolved ? ("done" as const) : ("open" as const),
    revision: 0,
    ...(resolved ? { completion: { revision: 0, by: "sessions" as const } } : null),
  };
  if (input.needsAttention && !input.attentionReason)
    return yield* error("Needs attention requires an attention reason");
  const next = yield* change(scope, (value) =>
    value.items.length >= 1000
      ? Effect.fail(error("To-do list is full"))
      : Effect.succeed({ ...value, items: [...value.items, item] }),
  );
  return next.items.find((candidate) => candidate.id === item.id)!;
});

export const update = Effect.fn("ProjectTodos.update")(function* (
  scope: string,
  request: ProjectTodoUpdate,
  user = false,
) {
  const [item] = yield* updateMany(scope, [request], user);
  if (!item) return yield* error("Unknown to-do in this list");
  return item;
});

/** Validate and commit the whole bounded batch in one storage transaction, or write nothing. */
export const updateMany = Effect.fn("ProjectTodos.updateMany")(function* (
  scope: string,
  requests: readonly ProjectTodoUpdate[],
  user = false,
  resolved: ReadonlySet<string> = new Set(),
) {
  const inputs = yield* Schema.decodeUnknownEffect(ProjectTodoUpdates)(requests).pipe(mapError);
  const next = yield* change(scope, (value) =>
    Effect.gen(function* () {
      let result = value;
      for (const input of inputs) {
        const item = result.items.find((item) => item.id === input.id);
        if (!item) return yield* error("Unknown to-do in this list");
        // Only a redundant done is special: a redundant open still commits a revision, so an
        // explicit "keep open" beats a racing automatic completion.
        const alreadyDone = input.state === "done" && item.state === "done";
        const edits =
          input.title !== undefined ||
          input.description !== undefined ||
          input.status !== undefined ||
          input.associations !== undefined ||
          input.needsAttention !== undefined ||
          input.attentionReason !== undefined ||
          input.snoozedUntil !== undefined;
        // Retrying the exact same link replacement is a no-op, including stale retries.
        const { id: _id, expectedRevision: _revision, associations, ...other } = input;
        if (
          associations !== undefined &&
          Object.keys(other).length === 0 &&
          JSON.stringify(associations) === JSON.stringify(item.associations)
        )
          continue;
        // Already done and nothing else changes: idempotent, no new revision.
        if (alreadyDone && !edits) continue;
        // A completion changes only state. A stale "done" edit that raced exactly that completion
        // agrees with it, so its other fields overwrite nothing newer; anything else conflicts.
        if (
          item.revision !== input.expectedRevision &&
          !(alreadyDone && onlyCompletedSince(item, input.expectedRevision))
        )
          return yield* conflict(item, input);
        const deadline =
          input.snoozedUntil == null
            ? input.snoozedUntil
            : DateTime.formatIso(DateTime.makeUnsafe(input.snoozedUntil));
        if (deadline != null) {
          if (item.state === "done" || input.state === "done")
            return yield* error("Only open to-dos can be snoozed; reopen the item first");
          if (deadline <= DateTime.formatIso(yield* DateTime.now))
            return yield* error("Snooze deadline must be in the future");
        }
        const attentionReason = input.attentionReason ?? item.attentionReason;
        // An off flag with a retained reason represents a dismissed request. Only the user
        // can restore that exact request; agents must have a genuinely new reason.
        const repeatedDismissal =
          !user &&
          !item.needsAttention &&
          Boolean(item.attentionReason) &&
          attentionReason === item.attentionReason;
        const needsAttention =
          input.needsAttention === true && repeatedDismissal
            ? false
            : (input.needsAttention ?? item.needsAttention ?? false);
        if (needsAttention && !attentionReason)
          return yield* error("Needs attention requires an attention reason");
        const automatic = input.state === undefined && resolved.has(item.id);
        const updated = commit(
          item,
          {
            title: input.title ?? item.title,
            description: input.description ?? item.description,
            status: input.status ?? item.status,
            needsAttention,
            ...(attentionReason ? { attentionReason } : null),
            state: input.state ?? (automatic && item.state === "open" ? "done" : item.state),
            associations: input.associations ?? item.associations,
          },
          automatic ? "sessions" : user ? "user" : "agent",
          deadline,
        );
        result = {
          ...result,
          items: result.items.map((candidate) => (candidate.id === item.id ? updated : candidate)),
        };
        if (user && (input.needsAttention !== undefined || input.attentionReason !== undefined))
          result = enqueue(result, {
            _tag: "Attention",
            sequence: result.sequence + 1,
            id: item.id,
            title: updated.title,
            needsAttention: Boolean(updated.needsAttention),
            ...(updated.attentionReason ? { attentionReason: updated.attentionReason } : null),
          });
        if (user && updated.state !== item.state)
          result = enqueue(result, {
            _tag: "ItemState",
            sequence: result.sequence + 1,
            id: item.id,
            title: updated.title,
            state: updated.state,
          });
      }
      return result;
    }),
  );
  return inputs.flatMap((input) => next.items.filter((item) => item.id === input.id));
});

/** Persist automatic completion through the same authority/projection as explicit user edits.
 * No write/publication for a repeated reconciliation with no candidates.
 */
export const completeResolved = Effect.fn("ProjectTodos.completeResolved")(function* (
  scope: string,
  candidates: readonly Pick<ProjectTodo, "id" | "revision">[],
) {
  if (!candidates.length) return;
  yield* change(scope, (value) => {
    let result = value;
    for (const candidate of candidates) {
      const item = result.items.find((item) => item.id === candidate.id);
      if (!item || item.state !== "open" || item.revision !== candidate.revision) continue;
      const updated = commit(item, { state: "done" }, "sessions");
      result = enqueue(
        { ...result, items: result.items.map((other) => (other.id === item.id ? updated : other)) },
        {
          _tag: "ItemState",
          id: item.id,
          title: item.title,
          state: "done",
          sequence: result.sequence + 1,
        },
      );
    }
    return Effect.succeed(result);
  });
});

const changeKey = (entry: ProjectTodoUserChange) =>
  entry._tag === "Selection"
    ? "selection"
    : entry._tag === "ItemState"
      ? `item:${entry.id}`
      : entry._tag === "Attention"
        ? `attention:${entry.id}`
        : `session:${entry.sessionId}`;
function enqueue(value: ProjectTodos, entry: ProjectTodoUserChange): ProjectTodos {
  return {
    ...value,
    sequence: entry.sequence,
    deliveryToken: randomUUID(),
    pending: [...value.pending.filter((old) => changeKey(old) !== changeKey(entry)), entry],
  };
}

export const mutateUser = Effect.fn("ProjectTodos.mutateUser")(function* (
  scope: string,
  request: ProjectTodoUserMutation,
) {
  const input = yield* Schema.decodeUnknownEffect(ProjectTodoUserMutation)(request).pipe(mapError);
  if (input._tag === "Snooze" || input._tag === "Unsnooze") {
    yield* update(
      scope,
      {
        id: input.id,
        expectedRevision: input.expectedRevision,
        snoozedUntil: input._tag === "Snooze" ? input.until : null,
      },
      true,
    );
    return yield* list(scope);
  }
  if (input._tag === "SetAttention") {
    yield* update(
      scope,
      {
        id: input.id,
        expectedRevision: input.expectedRevision,
        needsAttention: input.needsAttention,
        ...(input.attentionReason ? { attentionReason: input.attentionReason } : null),
      },
      true,
    );
    return yield* list(scope);
  }
  if (input._tag === "SetState") {
    yield* update(
      scope,
      { id: input.id, expectedRevision: input.expectedRevision, state: input.state },
      true,
    );
    return yield* list(scope);
  }
  return yield* change(scope, (value) => {
    if (
      input.selectedId !== null &&
      !value.items.some(
        (item) => item.id === input.selectedId && item.state === "open" && !item.snoozedUntil,
      )
    )
      return Effect.fail(error("Select an active to-do in this list"));
    // View focus is presentation, never context for an outgoing message.
    return Effect.succeed({ ...value, selectedId: input.selectedId });
  });
});

/** Creation bookkeeping, serialized by the same authority as manual edits.
 * Stable identity keeps retries idempotent even after an agent edits the links. */
export const ensureSession = Effect.fn("ProjectTodos.ensureSession")(function* (
  scope: string,
  sessionId: string,
  title: string,
  brief: string,
) {
  const hash = createHash("sha256").update(`cake:session-todo:${sessionId}`).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const name = normalizeSessionTitle(title) || "New Project Session";
  // Never copy launch instructions/bookkeeping into the visible task description.
  const description = `Continue work on ${name}.`;
  let created = false;
  const next = yield* change(scope, (value, current) => {
    const existing = owners(current, sessionId);
    if (existing.length > 1) return Effect.fail(ownershipError(sessionId, existing));
    if (existing.length || value.items.some((item) => item.id === id)) return Effect.succeed(value);
    if (value.items.length >= 1000) return Effect.fail(error("To-do list is full"));
    created = true;
    return Effect.succeed({
      ...value,
      items: [
        ...value.items,
        {
          id,
          title: name,
          description,
          status: "",
          needsAttention: false,
          state: "open" as const,
          revision: 0,
          associations: [{ kind: "session" as const, sessionId, title: name }],
        },
      ],
    });
  });
  // Only the transaction that created the durable item queues advisory work. Retries,
  // restores and concurrent admission paths reuse the owner without resummarizing it.
  const candidate = created ? next.items.find((item) => item.id === id) : undefined;
  if (candidate && brief.trim()) {
    const reports = yield* Effect.serviceOption(ProjectTodoReports);
    if (Option.isSome(reports))
      yield* reports.value.offerInitial({
        scope,
        id: candidate.id,
        revision: candidate.revision,
        brief,
      });
  }
});

/** Once a session/turn is admitted (or a fork exists), secondary to-do storage must not
 * turn that success into a retryable launch failure. Keep the accepted identity and diagnose
 * expected bookkeeping failures separately; defects and interruption are not recovered here. */
export const ensureAdmittedSession = Effect.fn("ProjectTodos.ensureAdmittedSession")(function* (
  scope: string,
  sessionId: string,
  title: string,
  brief: string,
) {
  yield* ensureSession(scope, sessionId, title, brief).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Accepted session could not be recorded in the to-do list", error).pipe(
        Effect.annotateLogs({ scope, sessionId }),
      ),
    ),
  );
});

/** Call only after native lifecycle authority confirms an actual transition (UI or tool). */
export const recordSessionChange = Effect.fn("ProjectTodos.recordSessionChange")(function* (
  scope: string,
  sessionId: string,
  title: string,
  resolved: boolean,
) {
  yield* change(scope, (value) =>
    Effect.succeed(
      enqueue(value, {
        _tag: "SessionState",
        sequence: value.sequence + 1,
        sessionId,
        title,
        resolved,
      }),
    ),
  );
});

/** Read-only preparation. Only consumed durable originals can acknowledge this receipt. */
export const prepareUserContext = Effect.fn("ProjectTodos.prepareUserContext")(function* (
  scope: string,
  text: string,
) {
  const value = yield* list(scope);
  const reminder = projectTodoReminder(value, todoChatForScope(scope));
  const digest = splitSessionDigestReminder(text);
  return {
    text: addSessionDigestReminder(
      reminder ? `${reminder}\n\n${digest.text}` : digest.text,
      digest.reminder,
    ),
    sequence: value.sequence,
  };
});

/** The to-do list owned by a permanent chat, if that chat keeps one. */
const scopeForChat = Effect.fn("ProjectTodos.scopeForChat")(function* (sessionId: string) {
  if (sessionId === CAKE_CHAT_SESSION_ID) return CAKE_CHAT_TODO_SCOPE;
  if (!isProjectChatSessionId(sessionId)) return undefined;
  const application = yield* ApplicationState;
  const project = application
    .snapshot()
    .projects.find((item) => projectChatSessionId(item.path) === sessionId);
  if (!project) return yield* error("Unknown Project Chat");
  return project.path;
});

export const prepareForChat = Effect.fn("ProjectTodos.prepareForChat")(function* (
  sessionId: string,
  text: string,
) {
  const scope = yield* scopeForChat(sessionId);
  if (scope === undefined) return { text };
  const prepared = yield* prepareUserContext(scope, text);
  return { text: prepared.text };
});

export const acknowledge = Effect.fn("ProjectTodos.acknowledge")(function* (
  scope: string,
  receipt: ProjectTodoContextReceipt,
) {
  const matches = (value: ProjectTodos) =>
    value.deliveryToken === receipt.token && value.sequence === receipt.sequence;
  const value = yield* list(scope);
  if (!value.pending.length || !matches(value)) return;
  yield* change(scope, (current) =>
    Effect.succeed(matches(current) ? { ...current, pending: [], deliveryToken: null } : current),
  );
});
