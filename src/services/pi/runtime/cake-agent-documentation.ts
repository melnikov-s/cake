import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sessions from "../../../../docs/agent/sessions.md?raw";
import cakeChat from "../../../../docs/agent/cake-chat.md?raw";
import workgroups from "../../../../docs/agent/workgroups.md?raw";
import familyStartup from "../../../../docs/agent/family-startup.md?raw";
import familyDelegation from "../../../../docs/agent/family-delegation.md?raw";
import familyCoordination from "../../../../docs/agent/family-coordination.md?raw";
import familyLifecycle from "../../../../docs/agent/family-lifecycle.md?raw";
import artifacts from "../../../../docs/agent/artifacts.md?raw";
import models from "../../../../docs/agent/models.md?raw";
import presentation from "../../../../docs/agent/presentation.md?raw";
import interactions from "../../../../docs/agent/interactions.md?raw";
import application from "../../../../docs/agent/application.md?raw";
import chatTodos from "../../../../docs/agent/chat-todos.md?raw";
import delegation from "../../../../docs/agent/delegation.md?raw";
import communication from "../../../../docs/agent/communication.md?raw";
import reports from "../../../../docs/agent/reports.md?raw";
import settings from "../../../../docs/agent/settings.md?raw";
import sessionDiscovery from "../../../../docs/agent/session-discovery.md?raw";
import sessionHistory from "../../../../docs/agent/session-history.md?raw";

import taskIndex from "../../../../docs/agent/index.md?raw";
import artifactDesigns from "../../../../docs/agent/artifact-designs.md?raw";
import artifactRuntime from "../../../../docs/agent/artifact-runtime.md?raw";
import widgetAuthoring from "../../../../docs/agent/widget-authoring.md?raw";
import widgetTheme from "../../../../docs/agent/widget-theme.md?raw";
import deliveryDetails from "../../../../docs/agent/delivery-details.md?raw";
import familyDetails from "../../../../docs/agent/family-details.md?raw";
import settingsVoice from "../../../../docs/agent/settings-voice.md?raw";
import settingsThemes from "../../../../docs/agent/settings-themes.md?raw";
import historyMemory from "../../../../docs/agent/history-memory.md?raw";
import sessionCompaction from "../../../../docs/agent/session-compaction.md?raw";
import sessionPromptFiles from "../../../../docs/agent/session-prompt-files.md?raw";
import sessionDiscoveryDetails from "../../../../docs/agent/session-discovery-details.md?raw";
import modelGeneration from "../../../../docs/agent/model-generation.md?raw";
import todoDetails from "../../../../docs/agent/todo-details.md?raw";

const documents = {
  index: taskIndex,
  "artifact-designs": artifactDesigns,
  "artifact-runtime": artifactRuntime,
  "widget-authoring": widgetAuthoring,
  "widget-theme": widgetTheme,
  "delivery-details": deliveryDetails,
  "family-details": familyDetails,
  "settings-voice": settingsVoice,
  "settings-themes": settingsThemes,
  "history-memory": historyMemory,
  "session-compaction": sessionCompaction,
  "session-prompt-files": sessionPromptFiles,
  "session-discovery-details": sessionDiscoveryDetails,
  "model-generation": modelGeneration,
  "todo-details": todoDetails,
  sessions,
  workgroups,
  "family-startup": familyStartup,
  "family-delegation": familyDelegation,
  "family-coordination": familyCoordination,
  "family-lifecycle": familyLifecycle,
  artifacts,
  models,
  presentation,
  interactions,
  "cake-chat": cakeChat,
  application,
  "chat-todos": chatTodos,
  delegation,
  communication,
  reports,
  settings,
  "session-discovery": sessionDiscovery,
  "session-history": sessionHistory,
};

/** Make bundled guidance readable with Pi's file tools in packaged and remote backends. */
export async function cakeAgentDocumentationDirectory(agentDir: string): Promise<string> {
  const revision = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
  const directory = join(agentDir, "cake-docs", revision);
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(documents).map(([name, content]) =>
      writeFile(join(directory, `${name}.md`), content),
    ),
  );
  return directory;
}
