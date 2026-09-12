import { describe, expect, it } from "vitest";
import {
  avatarPhysicsSettled,
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

  it("can be caught again during a fall", () => {
    const state = { ...restingAvatarPhysics(), y: -100, vy: 400 };
    for (let i = 0; i < 180; i++) stepAvatarPhysics(state, 1 / 60, { x: -40, y: -80 });
    expect(state.x).toBeCloseTo(-40, 1);
    expect(state.y).toBeCloseTo(-80, 1);
    expect(avatarPhysicsSettled(state)).toBe(false);
  });
});
