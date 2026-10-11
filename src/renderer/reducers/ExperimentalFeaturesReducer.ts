import { applySnapshot } from "r-state-tree";
import type { RendererApplicationProjection } from "../../contracts/application/application-data";
import type { ExperimentalFeatures } from "../models/ExperimentalFeatures";

export function applyExperimentalFeaturesProjection(
  model: ExperimentalFeatures,
  projection: RendererApplicationProjection,
) {
  if (projection.revision <= model.revision) return;
  applySnapshot(model, {
    revision: projection.revision,
    dynamicWorkflows: projection.state.experimentalFeatures?.dynamicWorkflows ?? false,
  });
}
