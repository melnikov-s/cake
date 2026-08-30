import { DateTime, Effect, Schema } from "effect";
import {
  ApplicationState as ApplicationStateSchema,
  type ApplicationState,
  type UtilityModel,
} from "./application-data";
import { ApplicationState as ApplicationStateOwner } from "../services/storage/ApplicationState";

class ApplicationPolicyError extends Schema.TaggedError<ApplicationPolicyError>()(
  "ApplicationPolicyError",
  { message: Schema.String },
) {}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const validate = (state: ApplicationState) =>
  Schema.decodeUnknownEffect(ApplicationStateSchema)(state).pipe(
    Effect.mapError((cause) => new ApplicationPolicyError({ message: cause.message })),
  );

const update = Effect.fn("Application.update")(function* (
  transition: (current: ApplicationState) => ApplicationState,
) {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => validate(transition(current)));
});

export const initialize = Effect.fn("Application.initialize")(function* () {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.initialize;
});

export const getState = Effect.fn("Application.getState")(function* () {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.current;
});

export const upsertProject = Effect.fn("Application.upsertProject")(function* (
  path: string,
  defaultName: string,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => {
    const existing = current.projects.find((project) => project.path === path);
    if (existing)
      return validate({
        ...current,
        projects: current.projects.map((project) =>
          project.path === path ? { ...project, lastOpenedAt: now } : project,
        ),
      });
    if (current.projects.length >= 200)
      return Effect.fail(new ApplicationPolicyError({ message: "Project registry is full" }));
    return validate({
      ...current,
      projects: [{ path, name: defaultName, addedAt: now, lastOpenedAt: now }, ...current.projects],
    });
  });
});

export const touchProject = Effect.fn("Application.touchProject")(function* (
  path: string,
  at?: string,
) {
  const touchedAt = at ?? DateTime.formatIso(yield* DateTime.now);
  return yield* update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.path === path ? { ...project, lastOpenedAt: touchedAt } : project,
    ),
  }));
});

export const renameProject = Effect.fn("Application.renameProject")(function* (
  path: string,
  name: string,
) {
  const nextName = name.trim().slice(0, 512);
  return yield* update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.path === path && nextName ? { ...project, name: nextName } : project,
    ),
  }));
});

export const removeProject = Effect.fn("Application.removeProject")(function* (path: string) {
  return yield* update((current) => ({
    ...current,
    projects: current.projects.filter((project) => project.path !== path),
    trustedProjectPaths: current.trustedProjectPaths.filter((trusted) => trusted !== path),
  }));
});

export const trustProject = Effect.fn("Application.trustProject")(function* (path: string) {
  const owner = yield* ApplicationStateOwner;
  return yield* owner.transact((current) => {
    if (current.trustedProjectPaths.includes(path)) return Effect.succeed(current);
    if (current.trustedProjectPaths.length >= 200)
      return Effect.fail(new ApplicationPolicyError({ message: "Project trust registry is full" }));
    return validate({
      ...current,
      trustedProjectPaths: [...current.trustedProjectPaths, path],
    });
  });
});

export const revokeProjectTrust = Effect.fn("Application.revokeProjectTrust")(function* (
  path: string,
) {
  return yield* update((current) => ({
    ...current,
    trustedProjectPaths: current.trustedProjectPaths.filter((trusted) => trusted !== path),
  }));
});

export const setUtilityModel = Effect.fn("Application.setUtilityModel")(function* (
  model: UtilityModel | undefined,
) {
  return yield* update((current) => ({ ...current, utilityModel: model }));
});

export const setVscodeServerPath = Effect.fn("Application.setVscodeServerPath")(function* (
  path: string | undefined,
) {
  return yield* update((current) => ({
    ...current,
    vscodeServerPath: path?.trim() || undefined,
  }));
});

export const setSessionFastMode = Effect.fn("Application.setSessionFastMode")(function* (
  sessionId: string,
  enabled: boolean,
) {
  return yield* update((current) => ({
    ...current,
    fastModeSessionIds: enabled
      ? unique([...current.fastModeSessionIds, sessionId])
      : current.fastModeSessionIds.filter((id) => id !== sessionId),
  }));
});

export const setCakeChatSessionResolved = Effect.fn("Application.setCakeChatSessionResolved")(
  function* (sessionId: string, resolved: boolean) {
    return yield* update((current) => ({
      ...current,
      resolvedCakeChatSessionIds: resolved
        ? unique([...current.resolvedCakeChatSessionIds, sessionId])
        : current.resolvedCakeChatSessionIds.filter((id) => id !== sessionId),
    }));
  },
);

export const setSessionsResolved = Effect.fn("Application.setSessionsResolved")(function* (
  sessionIds: ReadonlyArray<string>,
  resolved: boolean,
) {
  const changed = new Set(sessionIds);
  return yield* update((current) => ({
    ...current,
    resolvedSessionIds: resolved
      ? unique([...current.resolvedSessionIds, ...sessionIds])
      : current.resolvedSessionIds.filter((id) => !changed.has(id)),
    unreadSessionIds: resolved
      ? current.unreadSessionIds.filter((id) => !changed.has(id))
      : current.unreadSessionIds,
  }));
});

export const setSessionUnread = Effect.fn("Application.setSessionUnread")(function* (
  sessionId: string,
  unread: boolean,
) {
  return yield* update((current) => ({
    ...current,
    unreadSessionIds: unread
      ? unique([...current.unreadSessionIds, sessionId])
      : current.unreadSessionIds.filter((id) => id !== sessionId),
  }));
});

export const forgetProjectSessions = Effect.fn("Application.forgetProjectSessions")(function* (
  sessionIds: ReadonlyArray<string>,
) {
  const forgotten = new Set(sessionIds);
  return yield* update((current) => ({
    ...current,
    resolvedSessionIds: current.resolvedSessionIds.filter((id) => !forgotten.has(id)),
    unreadSessionIds: current.unreadSessionIds.filter((id) => !forgotten.has(id)),
    fastModeSessionIds: current.fastModeSessionIds.filter((id) => !forgotten.has(id)),
  }));
});

export const reconcileResolvedSessions = Effect.fn("Application.reconcileResolvedSessions")(
  function* (projectSessionIds: ReadonlyArray<string>, cakeChatSessionIds: ReadonlyArray<string>) {
    return yield* update((current) => ({
      ...current,
      resolvedSessionIds: unique(projectSessionIds),
      resolvedCakeChatSessionIds: unique(cakeChatSessionIds),
    }));
  },
);
