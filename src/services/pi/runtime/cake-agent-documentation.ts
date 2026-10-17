import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sessions from "../../../../docs/agent/sessions.md?raw";
import cakeChat from "../../../../docs/agent/cake-chat.md?raw";
import workgroups from "../../../../docs/agent/workgroups.md?raw";
import artifacts from "../../../../docs/agent/artifacts.md?raw";
import models from "../../../../docs/agent/models.md?raw";
import presentation from "../../../../docs/agent/presentation.md?raw";
import interactions from "../../../../docs/agent/interactions.md?raw";

const documents = {
  sessions,
  workgroups,
  artifacts,
  models,
  presentation,
  interactions,
  "cake-chat": cakeChat,
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
