import { Context } from "effect";

export interface ProjectSessionConfigurationService {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

/** Decoded process configuration for Project Session storage and Pi runtimes. */
export class ProjectSessionConfiguration extends Context.Service<
  ProjectSessionConfiguration,
  ProjectSessionConfigurationService
>()("cake/services/project-sessions/ProjectSessionConfiguration") {}
