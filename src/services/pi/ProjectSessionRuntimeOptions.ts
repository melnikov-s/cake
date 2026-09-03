import { Context } from "effect";
import type { ProjectSessionIntegrationHostOptions } from "./ProjectSessionIntegrationHost";

export type ProjectSessionRuntimeBase = Omit<
  ProjectSessionIntegrationHostOptions,
  "workspacePath" | "emit" | "emitApplicationControl" | "artifactRepository" | "reviewRepository"
>;

/** Shared Cake policy projected into Pi's Project Session callback contract. */
export class ProjectSessionRuntimeOptions extends Context.Service<
  ProjectSessionRuntimeOptions,
  {
    readonly forWorkingDirectory: (workingDirectory: string) => ProjectSessionRuntimeBase;
  }
>()("cake/services/pi/ProjectSessionRuntimeOptions") {}
