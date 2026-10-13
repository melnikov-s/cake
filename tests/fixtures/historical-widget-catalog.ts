import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-data";

/** A v3 catalog produced before widgets required retained browser output.
 * This unrelated record must not be decoded as a current widget merely to list metadata. */
export async function addHistoricalWidgetToCatalog(root: string) {
  const serialized = `${JSON.stringify(
    {
      protocol: "cake.artifact/v1",
      id: "historical-widget",
      sessionId: "historical-session",
      revision: 1,
      kind: "widget",
      title: "Historical widget",
      payload: {
        language: "react",
        source: "export default function Historical(){return null}",
        brief: "Historical fixture",
        generationSessionId: "historical-generation",
      },
      fallback: { markdown: "Historical widget" },
    },
    null,
    2,
  )}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const catalogPath = join(root, "catalog.json");
  const envelope = JSON.parse(await readFile(catalogPath, "utf8"));
  envelope.version = 3;
  for (const lineage of envelope.data.lineages)
    for (const revision of lineage.revisions) delete revision.title;
  envelope.data.lineages.push({
    id: "historical-widget",
    createdAt: new Date(0).toISOString(),
    latestRevision: 1,
    revisions: [
      {
        revision: 1,
        digest,
        kind: "widget",
        publishedAt: new Date(0).toISOString(),
        publishedBySessionId: "historical-session",
        workingDirectory: "/historical",
      },
    ],
  });
  envelope.data.links.push({
    lineageId: "historical-widget",
    target: { type: "session", sessionId: CAKE_CHAT_SESSION_ID },
    selection: { mode: "follow-latest" },
    createdAt: new Date(0).toISOString(),
  });
  await writeFile(join(root, "blobs", `${digest}.json`), serialized);
  await writeFile(catalogPath, JSON.stringify(envelope));
  return { digest, serialized };
}
