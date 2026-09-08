import type { SessionSnapshot } from "../../ipc/session-contract";
import { batch } from "r-state-tree";
import { modelOptionKey } from "../../utils/model-option-key";
import { LlmModel } from "../models/LlmModel";
import { Resource } from "../models/Resource";
import { RootProjection } from "../models/RootProjection";
import type { Session } from "../models/Session";

/** Register shared identities before applying session-owned references. */
export function applyConversationCatalog(session: Session, snapshot: SessionSnapshot) {
  if (!snapshot.model && !snapshot.models.length && !snapshot.compatibility.resources.length)
    return;
  const root = session.parent;
  if (!(root instanceof RootProjection))
    throw new Error("Session projection must belong to RootProjection");
  batch(() => {
    const models = new Map(root.llmModels.map((model) => [model.id, model]));
    for (const record of [...snapshot.models, ...(snapshot.model ? [snapshot.model] : [])]) {
      const id = modelOptionKey(record);
      const existing = models.get(id);
      if (existing) existing.name = record.name;
      else {
        const model = LlmModel.create({
          id,
          provider: record.provider,
          modelId: record.id,
          name: record.name,
        });
        root.llmModels.push(model);
        models.set(id, model);
      }
    }
    const resources = new Set(root.resources.map((resource) => resource.id));
    for (const record of snapshot.compatibility.resources) {
      if (resources.has(record.id)) continue;
      root.resources.push(Resource.create({ id: record.id, kind: record.kind, path: record.path }));
      resources.add(record.id);
    }
  });
}
