import type { MergeReadiness, MergeReadinessResult } from "./auto-merge";

export interface WorktreeLandingControl {
  reportReadiness?(readiness: MergeReadiness): Promise<MergeReadinessResult>;
  proposeSquashMessage(message: { subject: string; body?: string }): Promise<void>;
}
