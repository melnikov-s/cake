import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node-shared";
import { makeBackendLive } from "../../../src/backend/BackendLive";
import { resolveCakePaths } from "../../../src/config/CakePaths";
import { WorkflowSandbox } from "../../../src/services/pi/WorkflowSandbox";

const home = process.env.CAKE_HOME;
assert.ok(home);
const paths = resolveCakePaths({ env: { CAKE_HOME: home }, piAgentDirectory: join(home, "pi") });
const backend = makeBackendLive({ paths, homeDirectory: home }, () => Layer.empty);
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const sandbox = yield* WorkflowSandbox;
      const result = yield* sandbox.execute(
        {
          meta: { name: "compiled-sandbox", description: "Compiled host asset check" },
          sourcePath: join(home, "workflow.js"),
          args: { message: "compiled-node-ok" },
          source: `export const meta = { name: "compiled-sandbox", description: "Compiled host asset check" }; return { answer: await agent(args.message), process: typeof process };`,
        },
        {
          agent: (input) => Effect.succeed(input.prompt),
          phase: () => Effect.void,
          log: () => Effect.void,
        },
      );
      assert.deepEqual(result, { answer: "compiled-node-ok", process: "undefined" });
      console.log("compiled-workflow-backend-ok");
    }),
  ).pipe(Effect.provide(backend)),
);
