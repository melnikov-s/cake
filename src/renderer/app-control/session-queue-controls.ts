import { windowControlDefinitions } from "../../contracts/application/window-control-definitions";
import type { AppControlResult } from "./app-control-data";

import { defineSessionControl } from "./control-definition";
export const sessionQueueControls = [
  defineSessionControl({
    ...windowControlDefinitions["sessions.queue-command"],
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      return {
        ok: true,
        command,
        target,
        ...(await host.sessions.queueCommand(sessionId, input.command)),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.reorder"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.reorderQueuedMessage(
          input.sessionId,
          input.itemId,
          input.position,
        ),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.pending"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        result: await host.sessions.query(input.sessionId, { kind: "pending" }),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.dequeue"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const { sessionId } = input;
      return {
        ok: true,
        command,
        messages: await host.sessions.dequeuePendingMessages(sessionId),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.cancel-queued"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.removeQueuedMessage(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.steer-queued"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.steerQueuedMessage(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.send-now"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.sendQueuedMessageNow(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
    ...windowControlDefinitions["sessions.clear-queue"],
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const { sessionId } = input;
      return {
        ok: true,
        command,
        messages: await host.sessions.dequeuePendingMessages(sessionId),
      };
    },
  }),
];
