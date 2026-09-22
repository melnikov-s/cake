export interface AvatarPhysics {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  squash: number;
  squashVelocity: number;
}

export const restingAvatarPhysics = (): AvatarPhysics => ({
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  spin: 0,
  squash: 0,
  squashVelocity: 0,
});

const GRAVITY = 1800; // Screen pixels / second².
const RESTITUTION = 0.38;

/** A small upward tug and stretch make pickup spring off the perch. */
export function grabAvatarPhysics(state: AvatarPhysics): void {
  state.vy = Math.min(state.vy, -160);
  state.squash = -0.12;
  state.squashVelocity = 0;
}

/** Keep a quick mouse flick playful rather than launching the avatar off-screen. */
export function releaseAvatarPhysics(state: AvatarPhysics): void {
  const speed = Math.hypot(state.vx, state.vy);
  const transfer = Math.min(0.45, 600 / Math.max(speed, 1));
  state.vx *= transfer;
  state.vy *= transfer;
}

/** Spring while held, ballistic flight, then a springy return along the perch.
 * Returns the strongest contact speed this frame, so the face can feel a landing.
 */
export function stepAvatarPhysics(
  state: AvatarPhysics,
  elapsed: number,
  held?: { x: number; y: number },
): number {
  let strongestImpact = 0;
  let remaining = Math.min(Math.max(elapsed, 0), 0.05);
  while (remaining > 0) {
    const dt = Math.min(remaining, 1 / 120);
    remaining -= dt;
    if (held) {
      // Underdamped so pickup and changes of direction have a soft rebound.
      state.vx += ((held.x - state.x) * 160 - state.vx * 14) * dt;
      state.vy += ((held.y - state.y) * 160 - state.vy * 14) * dt;
      state.x += state.vx * dt;
      state.y += state.vy * dt;
      if (state.y > 0) {
        state.y = 0;
        state.vy = Math.min(0, state.vy);
      }
    } else if (state.y === 0 && state.vy === 0) {
      // Returning home is a grounded UI affordance, not a force during flight.
      // Underdamped: pass home slightly, then rebound rather than sliding to a stop.
      state.vx += (-state.x * 65 - state.vx * 9) * dt;
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
        strongestImpact = Math.max(strongestImpact, impact);
        state.squash = Math.min(0.34, impact / 1800);
        state.squashVelocity = 0;
        // Even a straight drop gets a little off-balance landing wiggle.
        state.spin += Math.sign(state.vx || state.angle || 1) * Math.min(85, impact * 0.16);
      } else {
        state.x += state.vx * dt;
        state.y = nextY;
        state.vy += GRAVITY * dt;
      }
    }
    const lean = held
      ? Math.max(-18, Math.min(18, state.vx * 0.065))
      : state.y === 0 && state.vy === 0
        ? Math.max(-10, Math.min(10, state.vx * 0.025))
        : 0;
    state.spin += ((lean - state.angle) * 110 - state.spin * 12) * dt;
    state.angle += state.spin * dt;
    // A deeper landing compression rebounds through a visible stretch.
    state.squashVelocity += (-state.squash * 220 - state.squashVelocity * 12) * dt;
    state.squash += state.squashVelocity * dt;
  }
  return strongestImpact;
}

export function avatarPhysicsSettled(state: AvatarPhysics): boolean {
  return (
    Math.abs(state.x) < 0.1 &&
    Math.abs(state.y) < 0.1 &&
    Math.abs(state.vx) < 0.5 &&
    Math.abs(state.vy) < 0.5 &&
    Math.abs(state.angle) < 0.1 &&
    Math.abs(state.spin) < 0.5 &&
    Math.abs(state.squash) < 0.005 &&
    Math.abs(state.squashVelocity) < 0.05
  );
}
