import { dragSessionAvatar } from "./drag-session-avatar";

const svgNamespace = "http://www.w3.org/2000/svg";
const randomBetween = (minimum: number, maximum: number) =>
  minimum + Math.random() * (maximum - minimum);

/** Prepare visible shapes before React owns the SVG markup. */
export function materializeSessionAvatar(markup: string): string {
  const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
  // Materialize DiceBear's reuse tree so geometry and animation target the visible
  // shapes directly, rather than browser-dependent <use> shadow-tree behavior.
  const definitions = new Map(
    Array.from(svg.querySelectorAll("[id]")).map((node) => [node.id, node]),
  );
  const expand = (root: Element) => {
    for (const use of root.querySelectorAll("use")) {
      const source = definitions.get(use.getAttribute("href")?.slice(1) ?? "");
      if (!source) continue;
      const group = document.createElementNS(svgNamespace, "g");
      const transform = use.getAttribute("transform");
      if (transform) group.setAttribute("transform", transform);
      const copy = source.cloneNode(true);
      if (!(copy instanceof Element)) continue;
      copy.removeAttribute("id");
      expand(copy);
      group.append(copy);
      use.replaceWith(group);
    }
  };
  for (const child of Array.from(svg.children)) {
    if (child.tagName !== "defs") expand(child);
  }
  return new XMLSerializer().serializeToString(svg);
}

/** Row-local feedback: no idle timers, pointer tracking, or React frame updates. */
export function interactWithSessionAvatar(
  host: HTMLElement,
  target: HTMLElement,
  activationTarget: HTMLElement,
): () => void {
  const look = host.querySelector<SVGGElement>(".dbga-hop .dbga-look");
  const hop = host.querySelector<SVGGElement>("svg > g .dbga-hop");
  if (!look || !hop) return () => {};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new Map<Element, Animation>();
  let pressed = false;
  let releaseTimer = 0;
  const restingTransform = "translateY(0px)";
  let curledTransform = restingTransform;
  const glanceEasings = [
    "cubic-bezier(0.22, 1, 0.36, 1)",
    "cubic-bezier(0.25, 0.8, 0.25, 1)",
    "cubic-bezier(0.33, 0, 0.2, 1)",
  ];
  const play = (element: Element, frames: Keyframe[], duration: number, easing = "ease-in-out") => {
    animations.get(element)?.cancel();
    const animation = element.animate(frames, { duration, easing });
    animations.set(element, animation);
    animation.onfinish = () => {
      animations.delete(element);
      animation.cancel();
    };
  };
  const glance = (right: boolean) => {
    if (reduced.matches || document.hidden) return;
    const from = getComputedStyle(look).transform;
    // SVG transforms use the 100-unit viewBox, not screen pixels. Sample a new
    // direction within a 60-degree cone on every hover, while keeping the same
    // six-unit travel distance used for the visible rightward glance.
    const angle = right ? (Math.random() - 0.5) * (Math.PI / 3) : 0;
    const to = right
      ? `translate(${Math.cos(angle) * 6}px, ${Math.sin(angle) * 6}px)`
      : "translate(0px, 0px)";
    // The resting transform survives completion; interrupted transitions start
    // at the currently displayed position instead of snapping.
    look.style.transform = to;
    // Sample only on interaction, with a quicker return so sweeping past rows
    // doesn't leave a trail of slow reactions. No background randomization.
    const duration = right ? 180 + Math.random() * 100 : 140 + Math.random() * 80;
    const easing = glanceEasings[Math.floor(Math.random() * glanceEasings.length)]!;
    play(look, [{ transform: from }, { transform: to }], duration, easing);
  };
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== "touch") glance(true);
  };
  const leave = () => {
    for (const [element, animation] of animations) {
      if (element === look) continue;
      animation.cancel();
      animations.delete(element);
    }
    glance(false);
  };
  const isMainAction = (event: Event) => {
    // NavItem's main button is a direct child. Status, disclosure, and trailing
    // actions must not impersonate selecting the item.
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    return button?.parentElement === activationTarget;
  };
  const press = (event: PointerEvent | KeyboardEvent) => {
    if (
      !isMainAction(event) ||
      (event instanceof PointerEvent && event.button !== 0) ||
      (event instanceof KeyboardEvent && (!["Enter", " "].includes(event.key) || event.repeat)) ||
      reduced.matches ||
      document.hidden
    )
      return;
    window.clearTimeout(releaseTimer);
    pressed = true;
    const curlAngle = randomBetween(-3.5, 3.5);
    const curlDepth = randomBetween(2, 4);
    const squashY = randomBetween(0.88, 0.95);
    const squashX = randomBetween(1.015, 1.055);
    const curlDuration = randomBetween(60, 105);
    curledTransform = `translate(50px, 50px) translateY(${curlDepth}px) rotate(${curlAngle}deg) scale(${squashX}, ${squashY}) translate(-50px, -50px)`;
    const from = getComputedStyle(hop).transform;
    hop.style.transform = curledTransform;
    play(hop, [{ transform: from }, { transform: curledTransform }], curlDuration, "ease-out");
  };
  const scheduleRelease = (event: PointerEvent | KeyboardEvent) => {
    if (
      !pressed ||
      (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) ||
      reduced.matches ||
      document.hidden
    )
      return;
    // A successful release emits click in the same task. Keep the curl through
    // that click so activate can flow directly into the existing pop animation;
    // otherwise gently restore after a cancelled or dragged-out press.
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      pressed = false;
      const from = getComputedStyle(hop).transform;
      hop.style.removeProperty("transform");
      play(hop, [{ transform: from }, { transform: restingTransform }], 160, "ease-out");
    });
  };
  const activate = (event: MouseEvent) => {
    if (!isMainAction(event) || reduced.matches || document.hidden) return;
    window.clearTimeout(releaseTimer);
    pressed = false;
    const from = getComputedStyle(hop).transform;
    const jumpHeight = randomBetween(5, 9);
    const jumpAngle = randomBetween(-20, 20) * (Math.PI / 180);
    const jumpX = Math.sin(jumpAngle) * jumpHeight;
    const jumpY = -Math.cos(jumpAngle) * jumpHeight;
    const jumpRotation = randomBetween(-4, 4);
    const jumpDuration = randomBetween(260, 390);
    const apexTransform = `translate(50px, 50px) translate(${jumpX}px, ${jumpY}px) rotate(${jumpRotation}deg) scale(0.98, 1.03) translate(-50px, -50px)`;
    hop.style.removeProperty("transform");
    play(
      hop,
      [{ transform: from }, { transform: apexTransform }, { transform: restingTransform }],
      jumpDuration,
    );
    for (const eye of hop.querySelectorAll<SVGGElement>(".dbga-eye")) {
      const box = eye.getBBox();
      const y = box.y + box.height / 2;
      play(
        eye,
        [
          { scale: 1, offset: 0 },
          { scale: 0.05, offset: 0.25 },
          { scale: 0.05, offset: 0.6 },
          { scale: 1, offset: 1 },
        ].map(({ scale, offset }) => ({
          transform: `translateY(${y}px) scaleY(${scale}) translateY(${-y}px)`,
          offset,
        })),
        jumpDuration * 0.875,
      );
    }
  };
  const reset = () => {
    window.clearTimeout(releaseTimer);
    pressed = false;
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
    look.style.removeProperty("transform");
    hop.style.removeProperty("transform");
  };
  target.addEventListener("pointerenter", enter);
  target.addEventListener("pointerleave", leave);
  activationTarget.addEventListener("pointerdown", press);
  activationTarget.addEventListener("keydown", press);
  activationTarget.addEventListener("click", activate);
  window.addEventListener("pointerup", scheduleRelease);
  window.addEventListener("pointercancel", scheduleRelease);
  window.addEventListener("keyup", scheduleRelease);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
  reduced.addEventListener("change", reset);
  return () => {
    reset();
    target.removeEventListener("pointerenter", enter);
    target.removeEventListener("pointerleave", leave);
    activationTarget.removeEventListener("pointerdown", press);
    activationTarget.removeEventListener("keydown", press);
    activationTarget.removeEventListener("click", activate);
    window.removeEventListener("pointerup", scheduleRelease);
    window.removeEventListener("pointercancel", scheduleRelease);
    window.removeEventListener("keyup", scheduleRelease);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", reset);
    reduced.removeEventListener("change", reset);
  };
}

/** Local, disposable DOM animation only; no workflow or persisted state. */
export function animateSessionAvatar(host: HTMLElement): () => void {
  const svg = host.querySelector("svg");
  if (!svg) return () => {};
  const hop = svg.querySelector<SVGGElement>("svg > g .dbga-hop");
  const look = hop?.querySelector<SVGGElement>(".dbga-look");
  const eyes = Array.from(hop?.querySelectorAll<SVGGElement>(".dbga-eye") ?? []);
  if (!hop || !look) return () => {};
  const body = look.parentElement?.querySelector<SVGGraphicsElement>(
    ":scope > path, :scope > rect, :scope > circle, :scope > ellipse",
  );
  const faceBox = look.getBBox();
  const bodyBox = body?.getBBox();
  // A bounding box is not the silhouette; retain a generous inset for rounded
  // and tapered heads and cap travel even on the widest characters.
  const travelX = bodyBox
    ? Math.max(
        0,
        Math.min(
          2.5,
          Math.min(faceBox.x - bodyBox.x, bodyBox.x + bodyBox.width - faceBox.x - faceBox.width) -
            5,
        ),
      )
    : 1;
  const travelY = bodyBox
    ? Math.max(
        0,
        Math.min(
          1.8,
          Math.min(faceBox.y - bodyBox.y, bodyBox.y + bodyBox.height - faceBox.y - faceBox.height) -
            5,
        ),
      )
    : 1;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const trigger = host.closest<HTMLButtonElement>("button");
  const animations = new Map<Element, Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;
  let pressed = false;
  let releaseTimer = 0;
  let pointer: { x: number; y: number } | undefined;
  let lookPosition = { x: 0, y: 0 };
  const restingTransform = "translateY(0px)";
  const play = (target: Element, frames: Keyframe[], duration: number, easing = "ease-in-out") => {
    animations.get(target)?.cancel();
    const animation = target.animate(frames, { duration, easing });
    animations.set(target, animation);
    animation.onfinish = () => {
      animations.delete(target);
      animation.cancel();
    };
  };
  const press = (event: PointerEvent | KeyboardEvent) => {
    if (
      (event instanceof PointerEvent && event.button !== 0) ||
      (event instanceof KeyboardEvent && (!["Enter", " "].includes(event.key) || event.repeat)) ||
      reduced.matches ||
      document.hidden
    )
      return;
    window.clearTimeout(releaseTimer);
    pressed = true;
    const curlTransform = `translate(50px, 50px) translateY(${randomBetween(2, 4)}px) rotate(${randomBetween(-3.5, 3.5)}deg) scale(${randomBetween(1.015, 1.055)}, ${randomBetween(0.88, 0.95)}) translate(-50px, -50px)`;
    const from = getComputedStyle(hop).transform;
    hop.style.transform = curlTransform;
    play(
      hop,
      [{ transform: from }, { transform: curlTransform }],
      randomBetween(60, 105),
      "ease-out",
    );
  };
  const scheduleRelease = (event: PointerEvent | KeyboardEvent) => {
    if (
      !pressed ||
      (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) ||
      reduced.matches ||
      document.hidden
    )
      return;
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      pressed = false;
      const from = getComputedStyle(hop).transform;
      hop.style.removeProperty("transform");
      play(hop, [{ transform: from }, { transform: restingTransform }], 160, "ease-out");
    });
  };
  const cancelPress = () => {
    if (!pressed) return;
    window.clearTimeout(releaseTimer);
    pressed = false;
    animations.get(hop)?.cancel();
    animations.delete(hop);
    hop.style.removeProperty("transform");
  };
  const clearReaction = () => {
    cancelPress();
    for (const target of [hop, ...eyes]) {
      animations.get(target)?.cancel();
      animations.delete(target);
    }
    hop.style.removeProperty("transform");
  };
  const physics = dragSessionAvatar(host, {
    onGrab: clearReaction,
    onImpact: (speed) => blink(Math.min(1, speed / 700)),
    onReset: clearReaction,
  });
  const activate = () => {
    if (reduced.matches || document.hidden || physics.active()) return;
    window.clearTimeout(releaseTimer);
    pressed = false;
    const from = getComputedStyle(hop).transform;
    const height = randomBetween(5, 9);
    const angle = randomBetween(-20, 20) * (Math.PI / 180);
    const x = Math.sin(angle) * height;
    const y = -Math.cos(angle) * height;
    const duration = randomBetween(520, 620);
    const tilt = randomBetween(-5, 5);
    const pose = (motion: string) => `translate(50px, 50px) ${motion} translate(-50px, -50px)`;
    hop.style.removeProperty("transform");
    play(
      hop,
      [
        { transform: from, offset: 0, easing: "ease-out" },
        {
          transform: pose(`translate(${x}px, ${y}px) rotate(${tilt}deg) scale(0.96, 1.06)`),
          offset: 0.3,
          easing: "ease-in",
        },
        {
          transform: pose(`translateY(3px) rotate(${-tilt * 0.6}deg) scale(1.12, 0.86)`),
          offset: 0.53,
          easing: "ease-out",
        },
        {
          transform: pose(`translateY(-3px) rotate(${tilt * 0.45}deg) scale(0.97, 1.04)`),
          offset: 0.72,
          easing: "ease-in-out",
        },
        {
          transform: pose(`translateY(1px) rotate(${-tilt * 0.2}deg) scale(1.025, 0.975)`),
          offset: 0.87,
          easing: "ease-out",
        },
        { transform: restingTransform, offset: 1 },
      ],
      duration,
      "linear",
    );
    for (const eye of eyes) {
      const box = eye.getBBox();
      const centerY = box.y + box.height / 2;
      play(
        eye,
        [
          { scale: 1, offset: 0 },
          { scale: 1, offset: 0.4 },
          { scale: 0.05, offset: 0.51 },
          { scale: 0.05, offset: 0.6 },
          { scale: 1, offset: 0.77 },
          { scale: 1, offset: 1 },
        ].map(({ scale, offset }) => ({
          transform: `translateY(${centerY}px) scaleY(${scale}) translateY(${-centerY}px)`,
          offset,
        })),
        duration,
        "linear",
      );
    }
  };
  const blink = (strength = 0.3) => {
    for (const eye of eyes) {
      const box = eye.getBBox();
      const y = box.y + box.height / 2;
      play(
        eye,
        [
          { transform: getComputedStyle(eye).transform, offset: 0 },
          { transform: `translateY(${y}px) scaleY(0.05) translateY(${-y}px)`, offset: 0.18 },
          { transform: `translateY(${y}px) scaleY(0.05) translateY(${-y}px)`, offset: 0.4 },
          { transform: `translateY(${y}px) scaleY(1) translateY(${-y}px)`, offset: 1 },
        ],
        140 + strength * 100,
      );
    }
  };
  const glance = () => {
    if (pressed || physics.active() || animations.has(hop)) return;
    const angle = Math.random() * Math.PI * 2;
    const target = {
      x: Math.cos(angle) * travelX,
      y: Math.sin(angle) * travelY,
    };
    const transform = ({ x, y }: { x: number; y: number }) => `translate(${x}px, ${y}px)`;
    play(
      look,
      [
        { transform: transform(lookPosition) },
        { transform: transform(target), offset: 0.25 },
        { transform: transform(target), offset: 0.65 },
        { transform: transform(lookPosition) },
      ],
      850,
    );
  };
  const bodyMotion = (motion: string[], duration: number) => {
    play(
      hop,
      motion.map((transform) => ({
        transform: `translate(50px, 50px) ${transform} translate(-50px, -50px)`,
      })),
      duration,
    );
  };
  const wobble = () => {
    if (pressed || physics.active() || animations.has(hop)) return;
    const angle = randomBetween(1, 2);
    bodyMotion(
      [
        "rotate(0deg)",
        `rotate(${-angle}deg) scale(1.012, 0.985)`,
        `rotate(${angle * 0.6}deg) scale(0.995, 1.008)`,
        `rotate(${-angle * 0.2}deg)`,
        "rotate(0deg)",
      ],
      randomBetween(900, 1200),
    );
  };
  const scheduleBetween = (action: () => void, minimum: number, maximum: number) => {
    const scheduleNext = () => {
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          action();
          scheduleNext();
        },
        minimum + Math.random() * (maximum - minimum),
      );
      timers.add(timer);
    };
    scheduleNext();
  };
  const resetLook = () => {
    pointer = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    lookPosition = { x: 0, y: 0 };
    look.removeAttribute("transform");
  };
  const updateLook = () => {
    frame = 0;
    if (!pointer) return;
    const matrix = look.getScreenCTM();
    if (!matrix) return;
    const local = new DOMPoint(pointer.x, pointer.y).matrixTransform(matrix.inverse());
    const dx = local.x - (faceBox.x + faceBox.width / 2);
    const dy = local.y - (faceBox.y + faceBox.height / 2);
    const distance = Math.max(30, Math.hypot(dx, dy));
    lookPosition = {
      x: (dx / distance) * travelX,
      y: (dy / distance) * travelY,
    };
    look.setAttribute("transform", `translate(${lookPosition.x} ${lookPosition.y})`);
  };
  const move = (event: PointerEvent) => {
    if (reduced.matches || document.hidden || event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(updateLook);
  };
  const stop = () => {
    window.clearTimeout(releaseTimer);
    pressed = false;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
    hop.style.removeProperty("transform");
    resetLook();
  };
  const refresh = () => {
    stop();
    if (reduced.matches || document.hidden) return;
    scheduleBetween(
      () => {
        if (!pressed && !physics.active() && !eyes.some((eye) => animations.has(eye))) blink();
      },
      5_000,
      8_000,
    );
    scheduleBetween(glance, 11_000, 15_000);
    scheduleBetween(wobble, 6_000, 10_000);
  };
  trigger?.addEventListener("pointerdown", press);
  trigger?.addEventListener("keydown", press);
  trigger?.addEventListener("click", activate);
  window.addEventListener("pointerup", scheduleRelease);
  window.addEventListener("pointercancel", scheduleRelease);
  window.addEventListener("keyup", scheduleRelease);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("blur", cancelPress);
  window.addEventListener("blur", resetLook);
  document.documentElement.addEventListener("pointerleave", resetLook);
  document.addEventListener("visibilitychange", refresh);
  reduced.addEventListener("change", refresh);
  refresh();
  return () => {
    stop();
    physics.dispose();
    trigger?.removeEventListener("pointerdown", press);
    trigger?.removeEventListener("keydown", press);
    trigger?.removeEventListener("click", activate);
    window.removeEventListener("pointerup", scheduleRelease);
    window.removeEventListener("pointercancel", scheduleRelease);
    window.removeEventListener("keyup", scheduleRelease);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("blur", cancelPress);
    window.removeEventListener("blur", resetLook);
    document.documentElement.removeEventListener("pointerleave", resetLook);
    document.removeEventListener("visibilitychange", refresh);
    reduced.removeEventListener("change", refresh);
  };
}
