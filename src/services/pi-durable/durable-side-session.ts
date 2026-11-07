import { defineDoc, type HarnessOptions } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Execution binding only. Pi's native parent edge remains the context authority. */
export const SideSessionDoc = defineDoc<{ workingDirectory?: string }>({
  kind: "cake.side-session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
  checkpointWhen: () => false,
});

export const sideSessionExecutionEnv =
  (scratchDirectory: string): HarnessOptions["env"] =>
  async ({ conversationId, read }, context) => {
    const binding = await read.snapshot(SideSessionDoc, conversationId, context);
    return new NodeExecutionEnv({ cwd: binding?.workingDirectory ?? scratchDirectory });
  };
