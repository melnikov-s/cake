import { Effect, Stream } from "effect";
import * as projectSessions from "../../domain/projectSessions";
import { ProjectSessionRpc } from "../protocol/ProjectSessionRpc";

export const projectSessionHandlers = ProjectSessionRpc.of({
  "projectSessions.list": () => projectSessions.list(),
  "projectSessions.observeCatalog": () => Stream.unwrap(projectSessions.observeCatalog()),
  "projectSessions.inspect": (target) => projectSessions.inspect(target),
  "projectSessions.start": (input) => projectSessions.start(input),
  "projectSessions.open": (target) => projectSessions.open(target),
  "projectSessions.observe": (target) => Stream.unwrap(projectSessions.observe(target)),
  "projectSessions.prompt": (input) => projectSessions.prompt(input),
  "projectSessions.steer": (input) => projectSessions.steer(input),
  "projectSessions.followUp": (input) => projectSessions.followUp(input),
  "projectSessions.abort": (target) => projectSessions.abort(target),
  "projectSessions.compact": ({ instructions, ...target }) =>
    projectSessions.compact(target, instructions),
  "projectSessions.editMessage": (input) => projectSessions.editMessage(input),
  "projectSessions.applyConfiguration": ({ configuration, ...target }) =>
    projectSessions.applyConfiguration(target, configuration),
  "projectSessions.setModel": ({ provider, modelId, ...target }) =>
    projectSessions.setModel(target, provider, modelId),
  "projectSessions.setThinkingLevel": ({ level, ...target }) =>
    projectSessions.setThinkingLevel(target, level),
  "projectSessions.setFastMode": ({ enabled, ...target }) =>
    projectSessions.setFastMode(target, enabled),
  "projectSessions.getChangelog": (target) => projectSessions.getChangelog(target),
  "projectSessions.navigate": ({ entryId, ...target }) => projectSessions.navigate(target, entryId),
  "projectSessions.setPiSetting": ({ update, ...target }) =>
    projectSessions.setPiSetting(target, update),
  "projectSessions.reload": (target) => projectSessions.reload(target),
  "projectSessions.login": ({ provider, authType, ...target }) =>
    projectSessions.login(target, provider, authType),
  "projectSessions.logout": ({ provider, ...target }) => projectSessions.logout(target, provider),
  "projectSessions.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessions.handoff>[0] = { target, entryId };
    if (prompt !== undefined) Object.assign(input, { prompt });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessions.handoff(input);
  },
  "projectSessions.rename": ({ name, ...target }) => projectSessions.rename(target, name),
  "projectSessions.fork": ({ entryId, destinationWorkingDirectory, resolveSource, ...target }) => {
    const input: Parameters<typeof projectSessions.fork>[0] = { target, entryId };
    if (destinationWorkingDirectory !== undefined)
      Object.assign(input, { destinationWorkingDirectory });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return projectSessions.fork(input);
  },
  "projectSessions.resolve": (target) => projectSessions.resolve(target).pipe(Effect.asVoid),
  "projectSessions.restore": (target) => projectSessions.restore(target).pipe(Effect.asVoid),
});
