import { Schema } from "effect";
import { expect, it } from "vitest";
import { MergeReadinessResult } from "../../../src/contracts/worktrees/auto-merge";
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
