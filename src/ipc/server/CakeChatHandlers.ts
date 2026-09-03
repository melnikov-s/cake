import { Stream } from "effect";
import * as cakeChats from "../../domain/cakeChats";
import { CakeChatRpc } from "../protocol/CakeChatRpc";

export const cakeChatHandlers = CakeChatRpc.of({
  "cakeChats.observeCatalog": (query) => Stream.unwrap(cakeChats.observeCatalog(query)),
  "cakeChats.inspect": ({ sessionId }) => cakeChats.inspect(sessionId),
  "cakeChats.open": (target) => cakeChats.open(target),
  "cakeChats.observe": (target) => Stream.unwrap(cakeChats.observe(target)),
  "cakeChats.prompt": (input) => cakeChats.prompt(input),
  "cakeChats.abort": (target) => cakeChats.abort(target),
  "cakeChats.compact": ({ instructions, ...target }) => cakeChats.compact(target, instructions),
  "cakeChats.editMessage": (input) => cakeChats.editMessage(input),
  "cakeChats.setUserMessageMarkdown": ({ entryId, renderAsMarkdown, ...target }) =>
    cakeChats.setUserMessageMarkdown(target, entryId, renderAsMarkdown),
  "cakeChats.applyConfiguration": ({ configuration, ...target }) =>
    cakeChats.applyConfiguration(target, configuration),
  "cakeChats.setModel": ({ provider, modelId, ...target }) =>
    cakeChats.setModel(target, provider, modelId),
  "cakeChats.setThinkingLevel": ({ level, ...target }) => cakeChats.setThinkingLevel(target, level),
  "cakeChats.setFastMode": ({ enabled, ...target }) => cakeChats.setFastMode(target, enabled),
  "cakeChats.rename": ({ name, ...target }) => cakeChats.rename(target, name),
  "cakeChats.handoff": ({ entryId, prompt, resolveSource, ...target }) => {
    const input: Parameters<typeof cakeChats.handoff>[0] = { target, entryId };
    if (prompt !== undefined) Object.assign(input, { prompt });
    if (resolveSource !== undefined) Object.assign(input, { resolveSource });
    return cakeChats.handoff(input);
  },
  "cakeChats.resolve": (target) => cakeChats.resolve(target),
  "cakeChats.restore": (target) => cakeChats.restore(target),
  "cakeChats.deleteResolved": (target) => cakeChats.deleteResolved(target),
  "cakeChats.respondControl": ({ controlRequestId, result }) =>
    cakeChats.respondControl(controlRequestId, result),
});
