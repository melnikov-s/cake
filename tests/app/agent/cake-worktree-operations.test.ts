import { Schema } from "effect";
import { expect, it } from "vitest";
import { MergeReadiness, MergeReadinessResult } from "../../../src/contracts/worktrees/auto-merge";
import { createCakeWorktreeOperations } from "../../../src/domain/worktrees/cake-worktree-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

it.each([
  { eligible: true as const },
  { eligible: false as const, reason: "New input invalidated merge readiness" },
])("returns typed readiness receipts with explanations: %j", async (result) => {
  const registry = new CakeOperationRegistry(
    createCakeWorktreeOperations({
      reportReadiness: async () => result,
      proposeSquashMessage: async () => undefined,
    }),
  );
  const response = await registry.invoke(
    {
      command: "worktrees.reportReadiness",
      input: {
        readyToMerge: true,
        taskCompleted: true,
        validationPassed: true,
        validatedCommit: "a".repeat(40),
      },
    },
    { signal: new AbortController().signal, toolCallId: "readiness", runtime: {} },
  );
  expect(response.structuredContent).toEqual({ command: "worktrees.reportReadiness", result });
  expect(JSON.parse(response.text)).toEqual(result);
});

it("requires an explanation for ineligible readiness in the output contract", () => {
  expect(Schema.is(MergeReadinessResult)({ eligible: false })).toBe(false);
});

it("accepts readiness without a commit and only well-formed commit assertions", () => {
  const base = { readyToMerge: true, taskCompleted: true, validationPassed: true };
  const valid = Schema.is(MergeReadiness);
  expect(valid(base)).toBe(true);
  expect(valid({ ...base, validatedCommit: "2c77633c" })).toBe(true);
  expect(valid({ ...base, validatedCommit: "A".repeat(40) })).toBe(true);
  expect(valid({ ...base, validatedCommit: "2c77" })).toBe(false);
  expect(valid({ ...base, validatedCommit: "HEAD" })).toBe(false);
});
