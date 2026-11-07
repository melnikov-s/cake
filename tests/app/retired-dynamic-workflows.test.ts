import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { BackendRpc } from "../../src/ipc/protocol/BackendRpc";
import {
  ApplicationState,
  defaultApplicationState,
} from "../../src/contracts/application/application-data";
import { artifactEventSchema } from "../../src/contracts/application/cake-rpc-contract";
import { SettingsPageId } from "../../src/contracts/application/settings-navigation";
import { settingsCatalog } from "../../src/contracts/application/settings-catalog";
import { SETTINGS_NAV_GROUPS } from "../../src/renderer/lib/settings-search";

describe("retired Dynamic workflows boundaries", () => {
  it("removes execution and toggle RPCs without removing unrelated controls", () => {
    const commands = [...BackendRpc.requests.keys()];
    expect(commands.some((command) => command.startsWith("workflows."))).toBe(false);
    expect(commands).not.toContain("application.setExperimentalFeatures");
    for (const command of [
      "automations.create",
      "automations.trigger",
      "scheduledMessages.list",
      "projectWorkflow.setSessionLabels",
      "projectSessions.open",
    ])
      expect(commands).toContain(command);
  });

  it("removes the setting, navigation destination and search entry", () => {
    expect(settingsCatalog.some(({ key }) => key === "experimental.dynamicWorkflows")).toBe(false);
    expect(Schema.decodeUnknownResult(SettingsPageId)("experimental")._tag).toBe("Failure");
    expect(JSON.stringify(SETTINGS_NAV_GROUPS)).not.toMatch(/dynamic.workflows|experimental/i);
  });

  it("ignores an old flag without mutating its input or unrelated application data", () => {
    const old = {
      ...defaultApplicationState(),
      globalCustomInstructions: "Keep my instructions",
      unreadSessionIds: ["existing-session"],
      experimentalFeatures: { dynamicWorkflows: true },
    };
    const decoded = Schema.decodeUnknownSync(ApplicationState)(old);
    expect(decoded).not.toHaveProperty("experimentalFeatures");
    expect(decoded.globalCustomInstructions).toBe(old.globalCustomInstructions);
    expect(decoded.unreadSessionIds).toEqual(old.unreadSessionIds);
    expect(old.experimentalFeatures.dynamicWorkflows).toBe(true);
    expect(defaultApplicationState()).not.toHaveProperty("experimentalFeatures");
  });

  it("rejects legacy proposal events rather than rendering a runnable choice", () => {
    const result = Schema.decodeUnknownResult(artifactEventSchema)({
      type: "ui-request",
      requestId: "00000000-0000-4000-8000-000000000001",
      uiRequestId: "00000000-0000-4000-8000-000000000002",
      sessionId: "existing-session",
      kind: "workflow-choice",
      title: "Old proposal",
      message: "Do not run",
    });
    expect(result._tag).toBe("Failure");
  });
});
