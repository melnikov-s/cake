import type { Schema } from "effect";
import type { Client } from "../client/Client";
import { extractSavedDrafts } from "../../services/storage/WindowStateStorage";

/** Import stable legacy IDs into the selected endpoint before stripping its local snapshot.
 * A failed import or window save must leave the loaded snapshot untouched for retry. */
export async function migrateSavedDrafts(
  client: Pick<Client, "savedDrafts" | "windowState">,
  loadedWindow: Schema.Schema.Type<typeof Schema.Json>,
) {
  const extracted = extractSavedDrafts(loadedWindow);
  for (const record of extracted.records) {
    await client.savedDrafts.create({
      sessionId: record.sessionId,
      projectPath: record.projectPath,
      title: record.title,
      text: record.text,
      attachments: [...record.attachments],
      ...(record.configuration ? { configuration: record.configuration } : null),
      labelIds: [...record.labelIds],
      resolved: record.resolved,
      createdAt: record.createdAt,
      modifiedAt: record.modifiedAt,
    });
  }
  if (extracted.records.length) await client.windowState.save(extracted.windowSnapshot);
  return extracted.windowSnapshot;
}
