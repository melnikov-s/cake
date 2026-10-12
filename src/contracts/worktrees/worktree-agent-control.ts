export interface WorktreeLandingControl {
  proposeSquashMessage(message: { subject: string; body?: string }): Promise<void>;
}
