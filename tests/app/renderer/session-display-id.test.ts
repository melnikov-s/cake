import { describe, expect, it } from "vitest";
import { sessionDisplayId } from "../../../src/renderer/lib/session-display-id";
import {
  resolveSessionLinkReference,
  resolveSessionReference,
  sessionReference,
} from "../../../src/contracts/project-sessions/session-reference";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";

describe("session ID presentation", () => {
  const id = "01957936-0000-7000-8000-0001f80c961e";
  const other = "01957936-0000-7000-8000-0002f80c961e";

  it("uses trailing hex without changing canonical identity or agent reference syntax", () => {
    expect(sessionDisplayId(id, [id])).toBe("f80c961e");
    expect(sessionReference(id, [id])).toBe("s:f80c961e");
    expect(resolveSessionReference("s:f80c961e", [id])).toEqual({ ok: true, sessionId: id });
    expect(resolveSessionReference(id, [])).toEqual({ ok: true, sessionId: id });
    expect(resolveSessionLinkReference("f80c961e", [id])).toEqual({ ok: true, sessionId: id });
  });

  it("extends colliding suffixes but never treats a display label as an authoritative identity", () => {
    expect(sessionDisplayId(id, [id, other])).toBe("1f80c961e");
    expect(sessionDisplayId(other, [id, other])).toBe("2f80c961e");
    expect(resolveSessionReference("s:f80c961e", [id, other]).ok).toBe(false);
    expect(resolveSessionLinkReference("f80c961e", [id, other]).ok).toBe(false);
    expect(resolveSessionReference("s:1f80c961e", [id, other])).toEqual({
      ok: true,
      sessionId: id,
    });
    expect(resolveSessionReference("1f80c961e", [id, other]).ok).toBe(false);
  });

  it("preserves non-Project identities and Cake Chat's distinct label", () => {
    expect(sessionDisplayId("draft-1")).toBe("draft-1");
    expect(sessionDisplayId(CAKE_CHAT_SESSION_ID)).toBe("cake-chat");
  });
});
