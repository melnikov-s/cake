import { Context } from "effect";

export interface ProjectConfigurationService {
  readonly agentDirectory: string;
}

/** Decoded process configuration required by Project domain workflows. */
export class ProjectConfiguration extends Context.Service<
  ProjectConfiguration,
  ProjectConfigurationService
>()("cake/services/projects/ProjectConfiguration") {}
