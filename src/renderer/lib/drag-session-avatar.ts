import {
  avatarPhysicsSettled,
  grabAvatarPhysics,
  releaseAvatarPhysics,
  restingAvatarPhysics,
  stepAvatarPhysics,
} from "./avatar-physics";

/** Disposable, avatar-local pointer/animation state; no workflow state or persistence. */
export function dragSessionAvatar(
  host: HTMLElement,
  feedback: { onGrab: () => void; onImpact: (speed: number) => void; onReset: () => void },
) {
  const trigger = host.closest("button");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let state = restingAvatarPhysics();
  let pointer: { id: number; x: number; y: number; startX: number; startY: number } | undefined;
  let held: { x: number; y: number } | undefined;
  let origin: DOMRect | undefined;
  let bounds: DOMRect | undefined;
  let frame = 0;
  let lastTime = 0;
  let holdTimer = 0;
  let suppressClick = false;

  const render = () => {
    host.style.translate = `${state.x}px ${state.y}px`;
    host.style.rotate = `${state.angle}deg`;
    host.style.scale = `${1 + state.squash} ${1 - state.squash}`;
  };
  const tick = (now: number) => {
    frame = 0;
    const impact = stepAvatarPhysics(state, (now - lastTime) / 1000, held);
    lastTime = now;
    render();
    if (impact > 65) feedback.onImpact(impact);
    if (held || !avatarPhysicsSettled(state)) frame = requestAnimationFrame(tick);
    else {
      state = restingAvatarPhysics();
      host.style.removeProperty("translate");
      host.style.removeProperty("rotate");
      host.style.removeProperty("scale");
      delete host.dataset.physics;
    }
  };
  const start = () => {
    if (frame) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const updateTarget = () => {
    if (!pointer || !origin || !bounds) return;
    // The original perch is the floor. Keep the character inside its chat surface.
    held = {
      x: Math.max(
        bounds.left - origin.left + 4,
        Math.min(bounds.right - origin.right - 4, pointer.x - pointer.startX),
      ),
      y: Math.max(bounds.top - origin.top + 4, Math.min(-8, pointer.y - pointer.startY - 8)),
    };
  };
  const grab = () => {
    if (!pointer || held || !trigger) return;
    feedback.onGrab();
    grabAvatarPhysics(state);
    suppressClick = true;
    trigger.setPointerCapture(pointer.id);
    host.dataset.physics = "held";
    trigger.dataset.avatarHeld = "true";
    updateTarget();
    start();
  };
  const down = (event: PointerEvent) => {
    if (
      !trigger ||
      trigger.disabled ||
      !event.isPrimary ||
      event.button !== 0 ||
      pointer ||
      reduced.matches ||
      document.hidden
    )
      return;
    suppressClick = false;
    const box = host.getBoundingClientRect();
    origin = new DOMRect(box.x - state.x, box.y - state.y, box.width, box.height);
    bounds =
      host.closest('[data-slot="chat"]')?.getBoundingClientRect() ??
      new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX - state.x,
      startY: event.clientY - state.y,
    };
    holdTimer = window.setTimeout(grab, 180);
  };
  const move = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (Math.hypot(pointer.x - pointer.startX - state.x, pointer.y - pointer.startY - state.y) > 4)
      grab();
    if (held) {
      event.preventDefault();
      updateTarget();
    }
  };
  const release = () => {
    window.clearTimeout(holdTimer);
    const id = pointer?.id;
    pointer = undefined;
    if (held) {
      held = undefined;
      releaseAvatarPhysics(state);
      host.dataset.physics = "falling";
      start();
    }
    if (trigger) {
      delete trigger.dataset.avatarHeld;
      if (id !== undefined && trigger.hasPointerCapture(id)) trigger.releasePointerCapture(id);
    }
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId === pointer?.id) release();
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const reset = () => {
    release();
    cancelAnimationFrame(frame);
    frame = 0;
    state = restingAvatarPhysics();
    host.style.removeProperty("translate");
    host.style.removeProperty("rotate");
    host.style.removeProperty("scale");
    delete host.dataset.physics;
    feedback.onReset();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") reset();
  };
  trigger?.addEventListener("pointerdown", down);
  trigger?.addEventListener("click", click, true);
  trigger?.addEventListener("lostpointercapture", release);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("keydown", key);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", reset);
  document.addEventListener("visibilitychange", reset);
  reduced.addEventListener("change", reset);
  return {
    active: () => Boolean(host.dataset.physics),
    dispose: () => {
      reset();
      trigger?.removeEventListener("pointerdown", down);
      trigger?.removeEventListener("click", click, true);
      trigger?.removeEventListener("lostpointercapture", release);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", reset);
      reduced.removeEventListener("change", reset);
    },
  };
}
