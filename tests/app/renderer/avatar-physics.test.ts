import { describe, expect, it } from "vitest";
import {
  avatarPhysicsSettled,
  grabAvatarPhysics,
  releaseAvatarPhysics,
  restingAvatarPhysics,
  stepAvatarPhysics,
} from "../../../src/renderer/lib/avatar-physics";

describe("avatar physics", () => {
  it.each([1 / 30, 1 / 60, 1 / 144])(
    "springs upward on pickup, stretches, and settles at the held target (dt=%s)",
    (dt) => {
      const state = restingAvatarPhysics();
      grabAvatarPhysics(state);
      expect(state.vy).toBe(-160);
      expect(state.squash).toBe(-0.12);
      let highest = 0;
      let compressed = false;
      for (let i = 0; i < Math.ceil(3 / dt); i++) {
        expect(stepAvatarPhysics(state, dt, { x: 0, y: -8 })).toBe(0);
        highest = Math.min(highest, state.y);
        compressed ||= state.squash > 0.01;
      }
      expect(highest).toBeLessThan(-10);
      expect(highest).toBeGreaterThan(-20);
      expect(compressed).toBe(true);
      expect(state.y).toBeCloseTo(-8, 1);
      expect(state.vy).toBeCloseTo(0, 1);
      expect(state.squash).toBeCloseTo(0, 3);
    },
  );

  it.each([1 / 30, 1 / 60, 1 / 144])(
    "has a bounded, visible rebound when the held target moves (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), y: -8 };
      let furthest = 0;
      for (let i = 0; i < Math.ceil(3 / dt); i++) {
        stepAvatarPhysics(state, dt, { x: 100, y: -120 });
        furthest = Math.max(furthest, state.x);
        expect(state.y).toBeLessThanOrEqual(0);
      }
      expect(furthest).toBeGreaterThan(108);
      expect(furthest).toBeLessThan(125);
      expect(state.x).toBeCloseTo(100, 1);
      expect(state.y).toBeCloseTo(-120, 1);
    },
  );

  it.each([1 / 30, 1 / 60, 1 / 144])(
    "compresses deeply on landing then stretches without changing bounce energy (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), y: -120 };
      let compression = 0;
      let stretch = 0;
      for (let i = 0; i < Math.ceil(6 / dt); i++) {
        stepAvatarPhysics(state, dt);
        compression = Math.max(compression, state.squash);
        stretch = Math.min(stretch, state.squash);
      }
      expect(compression).toBeGreaterThan(0.28);
      expect(compression).toBeLessThanOrEqual(0.34);
      expect(stretch).toBeLessThan(-0.025);
      expect(stretch).toBeGreaterThan(-0.12);
      expect(avatarPhysicsSettled(state)).toBe(true);
    },
  );

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

  it.each([1 / 30, 1 / 60, 1 / 144])(
    "reports diminishing landing impulses, including a straight drop (dt=%s)",
    (dt) => {
      const state = { ...restingAvatarPhysics(), y: -200 };
      const impacts: number[] = [];
      let wiggled = false;
      let stretched = false;
      for (let i = 0; i < 600 && !avatarPhysicsSettled(state); i++) {
        const impact = stepAvatarPhysics(state, dt);
        if (impact > 0) impacts.push(impact);
        wiggled ||= Math.abs(state.angle) > 1;
        stretched ||= state.squash < -0.005;
      }
      expect(impacts[0]).toBeCloseTo(Math.sqrt(2 * 1800 * 200), 6);
      expect(impacts[1]).toBeCloseTo(impacts[0]! * 0.38, 6);
      expect(impacts[2]).toBeCloseTo(impacts[1]! * 0.38, 6);
      expect(wiggled).toBe(true);
      expect(stretched).toBe(true);
      expect(avatarPhysicsSettled(state)).toBe(true);
      expect(stepAvatarPhysics(state, dt)).toBe(0);
    },
  );

  it.each([-160, 160])("overshoots home and rebounds to rest from x=%s", (x) => {
    const state = { ...restingAvatarPhysics(), x };
    let overshoot = 0;
    let rebounded = false;
    for (let i = 0; i < 600 && !avatarPhysicsSettled(state); i++) {
      expect(stepAvatarPhysics(state, 1 / 60)).toBe(0);
      const pastHome = -state.x * Math.sign(x);
      overshoot = Math.max(overshoot, pastHome);
      if (pastHome > 1 && state.vx * Math.sign(x) > 0) rebounded = true;
    }
    expect(overshoot).toBeGreaterThan(8);
    expect(overshoot).toBeLessThan(30);
    expect(rebounded).toBe(true);
    expect(avatarPhysicsSettled(state)).toBe(true);
  });

  it("does not signal a landing while held, even against the floor", () => {
    const state = { ...restingAvatarPhysics(), y: -1, vy: 500 };
    expect(stepAvatarPhysics(state, 1 / 60, { x: 20, y: 0 })).toBe(0);
    expect(state.squash).toBe(0);
  });

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
