import assert from "node:assert/strict";
import { Exit, Schema, SchemaIssue } from "effect";
import { describe, it } from "vitest";
import { SubagentError } from "../../../src/contracts/subagents/subagent-data";
import { subagentErrorMessage } from "../../../src/domain/subagents/subagent-error-message";

const schemaFailure = () => {
  const exit = Schema.decodeUnknownExit(
    Schema.Struct({ task: Schema.String, count: Schema.Number }),
  )({ task: 1, count: "two" }, { errors: "all" });
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  assert.ok(Schema.isSchemaError(error));
  return error;
};

describe("subagentErrorMessage", () => {
  it("keeps plain string errors unchanged", () => {
    assert.equal(subagentErrorMessage("Model request failed"), "Model request failed");
    assert.equal(subagentErrorMessage(new Error("Socket closed")), "Socket closed");
  });

  it("flattens nested structured error objects", () => {
    const cause = Object.assign(new Error("outer"), {
      message: {
        message: "Provider rejected the request",
        issues: [{ message: "max_tokens too large" }, { message: { message: "bad model" } }],
      },
    });
    const message = subagentErrorMessage(cause);
    assert.equal(message, "Provider rejected the request: max_tokens too large; bad model");
    assert.equal(subagentErrorMessage({ code: 503 }), '{"code":503}');
  });

  it("formats Effect Schema issue composites and errors", () => {
    const error = schemaFailure();
    assert.ok(error.issue instanceof SchemaIssue.Composite);
    const fromIssue = subagentErrorMessage(error.issue);
    assert.match(fromIssue, /\["task"\]/);
    assert.match(fromIssue, /\["count"\]/);
    assert.equal(subagentErrorMessage(error), error.message);
    assert.equal(
      subagentErrorMessage({ message: "Decode failed", issues: [error.issue] }),
      `Decode failed: ${fromIssue}`,
    );
  });

  it("always produces a valid SubagentError message", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const cause of [
      undefined,
      null,
      42,
      circular,
      { message: { issues: [schemaFailure().issue] } },
    ]) {
      const error = new SubagentError({ operation: "run", message: subagentErrorMessage(cause) });
      assert.equal(typeof error.message, "string");
      assert.ok(error.message.length > 0);
    }
  });
});
