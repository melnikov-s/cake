import { Schema } from "effect";

/** Intended working relationship, never an authority or lifecycle boundary. */
export const SessionPurpose = Schema.Literals(["user", "delegated"]);
export type SessionPurpose = Schema.Schema.Type<typeof SessionPurpose>;

export const sessionPurposeLabel = (purpose: SessionPurpose) =>
  purpose === "user" ? "User Session" : "Delegated Session";

/** Legacy sessions stay User Sessions; do not infer intent from provenance or messages. */
export function sessionPurpose(
  document: {
    readonly sessionPurposes?: ReadonlyArray<{
      readonly sessionId: string;
      readonly purpose: SessionPurpose;
    }>;
  },
  sessionId: string,
): SessionPurpose {
  return document.sessionPurposes?.find((item) => item.sessionId === sessionId)?.purpose ?? "user";
}

export const sessionPurposeCreationGuidance =
  'Defaults to a Delegated Session: an assignment returning results to the delegating agent. Set purpose: "user" only when explicitly creating a User Session on a human’s behalf for direct ongoing work. For a discussion handoff, state the launch intent: receive context and wait, or read/investigate/prepare recommendations. A User Session is not an autonomous coding assignment; do not start implementation without human authorization or report back merely because an agent supplied context. Explicit human instructions to begin work take precedence. Conversion never stops running work. User Sessions default to no unsolicited completion delivery; explicit resultDelivery still applies. Both support sustained design and authorized coding in the same session; purpose changes neither permissions nor routing/security boundaries. Human steering does not convert delegated work.';
