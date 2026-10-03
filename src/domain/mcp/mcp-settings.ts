import { Effect } from "effect";
import {
  McpSettingsError,
  type McpScope,
  type McpSettingsRead,
  type McpSettingsMutation,
} from "./mcp-settings-data";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { McpSettings } from "../../services/pi/McpSettings";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";

const authorize = Effect.fn("McpSettings.authorize")(function* (scope: McpScope) {
  if (!scope.projectPath) return;
  const access = yield* ProjectAccess;
  const application = yield* ApplicationState;
  if (
    !(yield* access.isAllowed(scope.projectPath)) ||
    !application.snapshot().trustedProjectPaths.includes(scope.projectPath)
  )
    return yield* new McpSettingsError({
      message: "Open and trust this Project before editing its MCP configuration.",
    });
});
export const loadMcpSettings = Effect.fn("McpSettings.loadAuthorized")(function* (
  scope: McpSettingsRead,
) {
  yield* authorize(scope);
  return yield* (yield* McpSettings).load(scope);
});
export const mutateMcpSettings = Effect.fn("McpSettings.mutateAuthorized")(function* (
  input: McpSettingsMutation,
) {
  yield* authorize(input);
  const value = yield* (yield* McpSettings).mutate(input);
  const sessions = yield* CakeSessionRuntimes;
  yield* (
    input.projectPath ? sessions.reloadWorkingDirectory(input.projectPath) : sessions.reloadAll()
  ).pipe(
    Effect.mapError(
      () =>
        new McpSettingsError({
          message:
            "Configuration was saved, but Pi reload failed. Refresh settings and use Reload Pi to retry.",
        }),
    ),
  );
  return value;
});
