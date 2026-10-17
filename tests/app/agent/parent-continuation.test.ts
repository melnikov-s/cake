import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { cakeChatReportPolicy } from "../../../src/contracts/project-sessions/session-reporting";
import { BackendAgentInvocation } from "../../../src/contracts/application/backend-agent-control";
import { windowControlDefinitions } from "../../../src/contracts/application/window-control-definitions";
import { SessionSendBatchInput } from "../../../src/contracts/conversations/session-send-batch";
import { FamilyMessageInput } from "../../../src/domain/session-families/sessionFamilyMessaging";

const target = "00000000-0000-4000-8000-000000000001";

describe("parent continuation contract", () => {
  it.each(["none", "resume"] as const)(
    "%s always requests a result independently of silent/false",
    (continuation) => {
      expect(
        cakeChatReportPolicy({ report: "silent", expectsResponse: false, continuation }),
      ).toEqual({
        report: "digest",
        expectsResponse: true,
        continuation,
      });
      expect(cakeChatReportPolicy({ report: "digest", continuation })).toEqual({
        report: "digest",
        expectsResponse: true,
        continuation,
      });
      expect(cakeChatReportPolicy({ report: "interrupt", continuation })).toEqual({
        report: "interrupt",
        expectsResponse: true,
        continuation,
      });
    },
  );

  it("retains report defaults without using content or response expectation as continuation intent", () => {
    expect(cakeChatReportPolicy({})).toEqual({
      report: "digest",
      expectsResponse: true,
      continuation: "none",
    });
    expect(cakeChatReportPolicy({ expectsResponse: true })).toEqual({
      report: "digest",
      expectsResponse: true,
      continuation: "none",
    });
    expect(cakeChatReportPolicy({ expectsResponse: false })).toEqual({
      report: "silent",
      expectsResponse: false,
      continuation: "none",
    });
    expect(cakeChatReportPolicy({ report: "interrupt" })).toEqual({
      report: "interrupt",
      expectsResponse: true,
      continuation: "resume",
    });
  });

  it.each(["none", "resume"] as const)(
    "preserves %s across single, batch, family and global/project-chat creation inputs",
    (continuation) => {
      const send = { sessionId: target, text: "Delegate", continuation };
      expect(
        Schema.decodeUnknownSync(BackendAgentInvocation)({
          name: "sessions.send",
          arguments: send,
        }),
      ).toMatchObject({ arguments: { continuation } });
      expect(Schema.decodeUnknownSync(FamilyMessageInput)(send)).toMatchObject({ continuation });
      expect(
        Schema.decodeUnknownSync(SessionSendBatchInput)({
          sessionIds: [target],
          text: "Delegate",
          continuation,
        }),
      ).toMatchObject({ continuation });
      expect(
        Schema.decodeUnknownSync(windowControlDefinitions["sessions.create"].args)({
          workspacePath: "/project",
          name: "Task",
          initialPrompt: "Delegate",
          continuation,
        }),
      ).toMatchObject({ continuation });
    },
  );
});
