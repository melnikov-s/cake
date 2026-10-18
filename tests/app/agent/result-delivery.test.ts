import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ResultDelivery,
  migrateResultDelivery,
} from "../../../src/contracts/conversations/result-delivery";
import { BackendAgentInvocation } from "../../../src/contracts/application/backend-agent-control";
import { windowControlDefinitions } from "../../../src/contracts/application/window-control-definitions";
import { SessionSendBatchInput } from "../../../src/contracts/conversations/session-send-batch";
import { FamilyMessageInput } from "../../../src/domain/session-families/sessionFamilyMessaging";

const target = "00000000-0000-4000-8000-000000000001";

describe("result delivery contract", () => {
  it.each(ResultDelivery.literals)(
    "preserves %s across single, batch, family and chat creation inputs",
    (resultDelivery) => {
      const send = { sessionId: target, text: "Delegate", resultDelivery };
      expect(
        Schema.decodeUnknownSync(BackendAgentInvocation)({
          name: "sessions.send",
          arguments: send,
        }),
      ).toMatchObject({ arguments: { resultDelivery } });
      expect(Schema.decodeUnknownSync(FamilyMessageInput)(send)).toMatchObject({ resultDelivery });
      expect(
        Schema.decodeUnknownSync(SessionSendBatchInput)({
          sessionIds: [target],
          text: "Delegate",
          resultDelivery,
        }),
      ).toMatchObject({ resultDelivery });
      expect(
        Schema.decodeUnknownSync(windowControlDefinitions["sessions.create"].args)({
          workspacePath: "/project",
          name: "Task",
          initialPrompt: "Delegate",
          resultDelivery,
        }),
      ).toMatchObject({ resultDelivery });
    },
  );

  it.each([
    [{ continuation: "resume", report: "silent", expectsResponse: false }, "reply"],
    [{ continuation: "none", report: "interrupt" }, "notification"],
    [{ reportPolicy: "digest" }, "notification"],
    [{ report: "interrupt" }, "reply"],
    [{ report: "silent" }, "ignore"],
    [{ expectsResponse: false }, "ignore"],
    [{ expectsResponse: true }, "reply"],
  ] as const)("migrates persisted intent %j without losing its obligation", (input, expected) => {
    expect(migrateResultDelivery(input)).toBe(expected);
  });
});
