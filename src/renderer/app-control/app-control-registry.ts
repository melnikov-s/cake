import { Schema } from "effect";
import type { RegisteredControl, ControlContext, ControlScope } from "./control-definition";
import { applicationControls } from "./application-controls";
import { settingsControls } from "./settings-controls";
import { vscodeControls } from "./vscode-controls";
import { worktreeControls } from "./worktree-controls";
import { projectControls } from "./project-controls";
import { sessionInspectionControls } from "./session-inspection-controls";
import { sessionQueueControls } from "./session-queue-controls";
import { sessionLifecycleControls } from "./session-lifecycle-controls";
import { agentSettingsControls } from "./agent-settings-controls";

const decodeEnvelope = Schema.decodeUnknownPromise(Schema.Struct({ name: Schema.String }));

/** Immutable command catalog, not workflow state. Internal commands remain invocable
 * without being advertised; discovery scope does not replace target/trust validation.
 */
export class AppControlRegistry {
  private readonly controls = new Map<string, RegisteredControl>();

  constructor(definitions: readonly RegisteredControl[]) {
    for (const definition of definitions) {
      if (this.controls.has(definition.command))
        throw new Error(`Duplicate application control ${definition.command}`);
      this.controls.set(definition.command, definition);
    }
  }

  listTools(scope: Exclude<ControlScope, "internal">) {
    return [...this.controls.values()].flatMap((definition) => {
      if (definition.scope === "internal" || (scope === "global" && definition.scope !== "global"))
        return [];
      const tool = definition.tool();
      return tool ? [tool] : [];
    });
  }

  async invoke(untrustedInput: unknown, context: ControlContext) {
    const envelope = await decodeEnvelope(untrustedInput);
    const control = this.controls.get(envelope.name);
    if (!control) throw new Error(`Unknown application control ${envelope.name}`);
    return control.invoke(untrustedInput, context);
  }
}

export const appControlRegistry = new AppControlRegistry([
  ...applicationControls,
  ...settingsControls,
  ...vscodeControls,
  ...worktreeControls,
  ...projectControls,
  ...sessionInspectionControls,
  ...sessionQueueControls,
  ...sessionLifecycleControls,
  ...agentSettingsControls,
]);
