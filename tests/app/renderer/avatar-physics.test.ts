import { describe, expect, it } from "vitest";
import {
  avatarPhysicsSettled,
  releaseAvatarPhysics,
  restingAvatarPhysics,
  stepAvatarPhysics,
} from "../../../src/renderer/lib/avatar-physics";

describe("avatar physics", () => {
  it("follows the held target with spring lag and a bounded lean", () => {
    const state = restingAvatarPhysics();
    stepAvatarPhysics(state, 1 / 60, { x: 100, y: -120 });
    expect(state.x).toBeGreaterThan(0);
    expect(state.x).toBeLessThan(100);
    expect(state.y).toBeLessThan(0);
    for (let i = 0; i < 240; i++) stepAvatarPhysics(state, 1 / 60, { x: 100, y: -120 });
    expect(state.x).toBeCloseTo(100, 1);
    expect(state.y).toBeCloseTo(-120, 1);
    expect(Math.abs(state.angle)).toBeLessThan(1);
  });

  it.each([1 / 120, 1 / 60, 1 / 30, 0.5])(
    "falls, squashes, bounces and settles at the perch (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), x: 180, y: -160, vx: 300, angle: 12 };
      let bounced = false;
      for (let i = 0; i < 1200 && !avatarPhysicsSettled(state); i++) {
        const before = state.vy;
        stepAvatarPhysics(state, dt);
        if (before > 0 && state.vy < 0) {
          bounced = true;
          expect(state.squash).toBeGreaterThan(0);
        }
        expect(state.y).toBeLessThanOrEqual(0);
        expect(Number.isFinite(state.x)).toBe(true);
      }
      expect(bounced).toBe(true);
      expect(avatarPhysicsSettled(state)).toBe(true);
    },
  );

  it("softens release velocity, caps fast flicks, and preserves their direction", () => {
    const gentle = { ...restingAvatarPhysics(), vx: 200, vy: -400 };
    releaseAvatarPhysics(gentle);
    expect(gentle.vx).toBe(90);
    expect(gentle.vy).toBe(-180);

    const flick = { ...restingAvatarPhysics(), vx: 3000, vy: -4000 };
    releaseAvatarPhysics(flick);
    expect(Math.hypot(flick.vx, flick.vy)).toBeCloseTo(600);
    expect(flick.vx / flick.vy).toBeCloseTo(-0.75);

    const still = restingAvatarPhysics();
    releaseAvatarPhysics(still);
    expect(still).toEqual(restingAvatarPhysics());
  });

  it.each([1 / 30, 1 / 60, 1 / 144])(
    "follows a ballistic arc without pulling sideways toward home (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), x: 100, y: -300, vx: 120, vy: -180 };
      const frames = Math.round(0.2 / dt);
      const time = frames * dt;
      for (let i = 0; i < frames; i++) stepAvatarPhysics(state, dt);
      expect(state.x).toBeCloseTo(100 + 120 * time, 8);
      expect(state.vx).toBe(120);
      expect(state.y).toBeCloseTo(-300 - 180 * time + 900 * time * time, 8);
      expect(state.vy).toBeCloseTo(-180 + 1800 * time, 8);
    },
  );

  it.each([1 / 30, 1 / 60, 1 / 144])(
    "loses energy on each bounce with consistent rebound heights (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), y: -200 };
      const peaks: number[] = [];
      let peak = 0;
      for (let i = 0; i < 500 && !avatarPhysicsSettled(state); i++) {
        const before = state.vy;
        stepAvatarPhysics(state, dt);
        if (before >= 0 && state.vy < 0) peak = -state.y;
        if (state.vy < 0) peak = Math.max(peak, -state.y);
        if (before < 0 && state.vy >= 0) peaks.push(Math.max(peak, -state.y));
        expect(state.y).toBeLessThanOrEqual(0);
      }
      // A restitution of .38 retains .38² of the previous bounce height.
      expect(peaks[0]).toBeCloseTo(200 * 0.38 ** 2, 0);
      expect(peaks[1]).toBeCloseTo(200 * 0.38 ** 4, 0);
      expect(avatarPhysicsSettled(state)).toBe(true);
    },
  );

  it("does not generate repeated impacts or squash at rest", () => {
    const state = restingAvatarPhysics();
    for (let i = 0; i < 120; i++) stepAvatarPhysics(state, 1 / 60);
    expect(state).toEqual(restingAvatarPhysics());
  });

  it("keeps the floor solid when caught just before landing", () => {
    const state = { ...restingAvatarPhysics(), y: -1, vy: 600 };
    stepAvatarPhysics(state, 1 / 60, { x: 0, y: -8 });
    expect(state.y).toBeLessThanOrEqual(0);
    releaseAvatarPhysics(state);
    for (let i = 0; i < 120; i++) stepAvatarPhysics(state, 1 / 60);
    expect(avatarPhysicsSettled(state)).toBe(true);
  });

  it("can be caught again during a fall", () => {
    const state = { ...restingAvatarPhysics(), y: -100, vy: 400 };
    for (let i = 0; i < 180; i++) stepAvatarPhysics(state, 1 / 60, { x: -40, y: -80 });
    expect(state.x).toBeCloseTo(-40, 1);
    expect(state.y).toBeCloseTo(-80, 1);
    expect(avatarPhysicsSettled(state)).toBe(false);
  });
});
