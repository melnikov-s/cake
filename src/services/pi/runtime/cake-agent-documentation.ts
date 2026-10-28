import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sessions from "../../../../docs/agent/sessions.md?raw";
import cakeChat from "../../../../docs/agent/cake-chat.md?raw";
import workgroups from "../../../../docs/agent/workgroups.md?raw";
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

const documents = {
  sessions,
  workgroups,
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
