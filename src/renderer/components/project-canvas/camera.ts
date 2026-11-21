// Adapted from Rounds at 9b863e289f30c676b35379be5de2859f5858a273 (MIT). See ../../public/ROUNDS-LICENSE.txt.
import { useEffect, useMemo, useRef } from "react";

export type Cam = { x: number; y: number; z: number };
export const MIN_Z = 0.08;
export const MAX_Z = 2.4;
const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

// The camera writes straight to the page each frame through `apply`, never through React
// state, so a glide costs one transform, not a render of every card. Gestures move it with
// the hand; programmatic moves settle critically damped (no overshoot), by elapsed time so
// the feel holds at any frame rate. Zoom eases in log space so it reads even.
export function useCamera(apply: (c: Cam, settled: boolean) => void) {
  const target = useRef<Cam>({ x: 0, y: 0, z: 0.3 });
  const cur = useRef<Cam>({ ...target.current });
  const raf = useRef(0);
  const last = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const TAU = 0.11; // seconds; settles in about 0.45 s

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );
  return useMemo(() => {
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - (last.current || now)) / 1000 || 1 / 60);
      last.current = now;
      const c = cur.current,
        t = target.current;
      const k = 1 - Math.exp(-dt / TAU);
      const n = {
        x: c.x + (t.x - c.x) * k,
        y: c.y + (t.y - c.y) * k,
        z: c.z * Math.pow(t.z / c.z, k),
      };
      const done =
        Math.abs(n.x - t.x) < 0.25 &&
        Math.abs(n.y - t.y) < 0.25 &&
        Math.abs(n.z / t.z - 1) < 0.0008;
      cur.current = done ? { ...t } : n;
      applyRef.current(cur.current, done);
      raf.current = done ? 0 : requestAnimationFrame(tick);
    };
    const kick = () => {
      if (raf.current) return;
      last.current = 0;
      raf.current = requestAnimationFrame(tick);
    };

    return {
      /** Move now, with the hand. */
      jump(next: Cam) {
        next = { ...next, z: clampZ(next.z) };
        target.current = next;
        cur.current = next;
        cancelAnimationFrame(raf.current);
        raf.current = 0;
        applyRef.current(next, true);
      },
      /** Glide there. */
      glide(next: Cam) {
        target.current = { ...next, z: clampZ(next.z) };
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) this.jump(next);
        else kick();
      },
      get target() {
        return target.current;
      },
      get now() {
        return cur.current;
      },
    };
  }, []);
}

export function fit(
  rect: { x: number; y: number; w: number; h: number },
  vw: number,
  vh: number,
  pad = 120,
): Cam {
  const z = clampZ(Math.min((vw - pad * 2) / rect.w, (vh - pad * 2) / rect.h));
  return { z, x: vw / 2 - (rect.x + rect.w / 2) * z, y: vh / 2 - (rect.y + rect.h / 2) * z };
}

export function zoomAt(camera: Cam, to: number, x: number, y: number): Cam {
  const z = clampZ(to);
  const k = z / camera.z;
  return { z, x: x - (x - camera.x) * k, y: y - (y - camera.y) * k };
}
