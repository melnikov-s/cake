import { Schema } from "effect";
import { Model, createModel, type ModelInstance } from "effect-state-tree";
import { SessionSummary } from "./SessionSummary";

export const SessionSummaryCollection = createModel(
  "SessionSummaryCollection",
  Schema.Struct({
    sessions: Schema.Array(Model.child(SessionSummary.schema)),
  }),
  (self) => ({
    replace(sessions: ReadonlyArray<SessionSummary>) {
      const retained = new Set(sessions.map((session) => session.identity.value));
      const removed = self.sessions.value.filter(
        (session) => !retained.has(session.identity.value),
      );
      self.sessions.set([...sessions]);
      for (const session of removed) session[Symbol.dispose]();
    },
  }),
);

export type SessionSummaryCollection = ModelInstance<typeof SessionSummaryCollection>;
