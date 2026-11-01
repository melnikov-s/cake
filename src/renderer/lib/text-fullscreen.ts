/** Shared eligibility for message and cross-session text fullscreen actions. */
export function canFullscreenText(characterCount: number): boolean {
  return characterCount > 5_000;
}
