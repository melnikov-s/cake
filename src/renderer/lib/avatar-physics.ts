export interface AvatarPhysics {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  squash: number;
}

export const restingAvatarPhysics = (): AvatarPhysics => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  spin: 0,
  squash: 0,
});

/** Screen-pixel spring and gravity simulation. Substeps keep slow frames stable. */
export function stepAvatarPhysics(
  state: AvatarPhysics,
  elapsed: number,
  held?: { x: number; y: number },
): void {
  let remaining = Math.min(Math.max(elapsed, 0), 0.05);
  while (remaining > 0) {
    const dt = Math.min(remaining, 1 / 120);
    remaining -= dt;
    state.vx += ((held ? (held.x - state.x) * 240 : -state.x * 65) - state.vx * 20) * dt;
    state.vy += (held ? (held.y - state.y) * 240 - state.vy * 20 : 1500) * dt;
    state.x += state.vx * dt;
    state.y += state.vy * dt;
    if (!held && state.y >= 0) {
      state.y = 0;
      const impact = Math.abs(state.vy);
      state.vy = impact > 65 ? -impact * 0.34 : 0;
      state.squash = Math.min(0.18, impact / 3500);
      state.spin += state.vx * 0.08;
    }
    const lean = held ? Math.max(-18, Math.min(18, state.vx * 0.065)) : 0;
    state.spin += ((lean - state.angle) * 110 - state.spin * 12) * dt;
    state.angle += state.spin * dt;
    state.squash *= Math.exp(-12 * dt);
  }
}

export function avatarPhysicsSettled(state: AvatarPhysics): boolean {
  return (
    Math.abs(state.x) < 0.1 &&
    Math.abs(state.y) < 0.1 &&
    Math.abs(state.vx) < 0.5 &&
    Math.abs(state.vy) < 0.5 &&
    Math.abs(state.angle) < 0.1 &&
    Math.abs(state.spin) < 0.5 &&
    state.squash < 0.005
  );
}
