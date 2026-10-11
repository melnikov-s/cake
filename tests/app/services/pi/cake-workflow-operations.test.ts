import { describe, expect, it, vi } from "vitest";
import {
  CakeOperationRegistry,
  cakeToolDescription,
} from "../../../../src/services/pi/runtime/cake-operation-registry";
import {
  createCakeWorkflowOperations,
  type WorkflowControl,
} from "../../../../src/services/pi/runtime/cake-workflow-operations";

describe("Cake workflow proposal operation", () => {
  it("updates discovery and stale-call admission when the experiment changes in an existing session", async () => {
    let enabled = false;
    const invoke = vi.fn<WorkflowControl["invoke"]>(async () => ({ choice: "normal" }));
    const registry = new CakeOperationRegistry(
      createCakeWorkflowOperations({ invoke, isEnabled: () => enabled }),
    );
    const context = {
      signal: new AbortController().signal,
      toolCallId: "experiment",
      runtime: undefined,
    };
    const envelope = {
      command: "workflows.propose",
      input: { sessionId: "owner", scriptPath: "audit.js" },
    };
    expect(registry.help()).not.toContain("workflows");
    expect(registry.completeHelp()).not.toContain("workflows");
    expect(registry.operationHelp("workflows.propose")).toBeUndefined();
    await registry.invoke(envelope, context);
    expect(invoke).not.toHaveBeenCalled();
    enabled = true;
    expect(registry.help()).toContain("workflows");
    expect(registry.operationHelp("workflows.propose")).toContain("Run workflow");
    await registry.invoke(envelope, context);
    expect(invoke).toHaveBeenCalledTimes(1);
    enabled = false;
    expect(registry.help()).not.toContain("workflows");
    await registry.invoke(envelope, context);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("discovers the interactive suggested path and retains direct explicit start", async () => {
    const invoke = vi.fn<WorkflowControl["invoke"]>(async () => ({ choice: "normal" }));
    const registry = new CakeOperationRegistry(
      createCakeWorkflowOperations({ invoke, isEnabled: () => true }),
    );
    expect(registry.help()).toContain("workflows");
    expect(cakeToolDescription).toContain("currently enabled capabilities");
    expect(registry.operationHelp("workflows.propose")).toContain("Continue normally");
    expect(registry.operationHelp("workflows.start")).toContain("explicit user request");
    const input = {
      sessionId: "project-owner",
      scriptPath: "audit.js",
      args: { question: "audit" },
    };
    const context = {
      signal: new AbortController().signal,
      toolCallId: "proposal",
      runtime: undefined,
    };
    const result = await registry.invoke({ command: "workflows.propose", input }, context);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("workflows.propose", input, context.signal);
    expect(result.text).toContain('"choice": "normal"');
    await registry.invoke({ command: "workflows.start", input }, context);
    expect(invoke).toHaveBeenLastCalledWith("workflows.start", input, context.signal);
    await expect(
      registry.invoke({ command: "workflows.propose", input: { scriptPath: "audit.js" } }, context),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
