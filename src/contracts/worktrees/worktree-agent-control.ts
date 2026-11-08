import type { MergeReadiness } from "./auto-merge";

export interface WorktreeLandingControl {
  reportReadiness?(readiness: MergeReadiness): Promise<{ eligible: boolean }>;
  proposeSquashMessage(message: { subject: string; body?: string }): Promise<void>;
}
