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

const GRAVITY = 1800; // Screen pixels / second².
const RESTITUTION = 0.38;

/** Keep a quick mouse flick playful rather than launching the avatar off-screen. */
export function releaseAvatarPhysics(state: AvatarPhysics): void {
  const speed = Math.hypot(state.vx, state.vy);
  const transfer = Math.min(0.45, 600 / Math.max(speed, 1));
  state.vx *= transfer;
  state.vy *= transfer;
}

/** Spring while held, ballistic flight, then a damped return along the perch. */
export function stepAvatarPhysics(
  state: AvatarPhysics,
  elapsed: number,
  held?: { x: number; y: number },
): void {
  let remaining = Math.min(Math.max(elapsed, 0), 0.05);
  while (remaining > 0) {
    const dt = Math.min(remaining, 1 / 120);
    remaining -= dt;
    if (held) {
      state.vx += ((held.x - state.x) * 160 - state.vx * 24) * dt;
      state.vy += ((held.y - state.y) * 160 - state.vy * 24) * dt;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      if (state.y > 0) {
        state.y = 0;
        state.vy = Math.min(0, state.vy);
      }
    } else if (state.y === 0 && state.vy === 0) {
      // Returning home is a grounded UI affordance, not a force during flight.
      state.vx += (-state.x * 65 - state.vx * 20) * dt;
      state.x += state.vx * dt;
    } else {
      const nextY = state.y + state.vy * dt + 0.5 * GRAVITY * dt * dt;
      if (nextY >= 0) {
        // Resolve at the actual contact time, not the end of the frame. This
        // keeps bounce height consistent across refresh rates.
        const impact = Math.sqrt(state.vy * state.vy - 2 * GRAVITY * state.y);
        const contactTime = (impact - state.vy) / GRAVITY;
        const afterContact = dt - contactTime;
        state.x += state.vx * contactTime;
        state.vx *= 0.72; // Tangential energy lost to floor friction.
        state.x += state.vx * afterContact;
        state.y = 0;
        state.vy = impact > 65 ? -impact * RESTITUTION : 0;
        if (state.vy !== 0) {
          state.y = state.vy * afterContact + 0.5 * GRAVITY * afterContact ** 2;
          state.vy += GRAVITY * afterContact;
        }
        state.squash = Math.min(0.14, impact / 4500);
        state.spin += state.vx * 0.04;
      } else {
        state.x += state.vx * dt;
        state.y = nextY;
        state.vy += GRAVITY * dt;
      }
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
