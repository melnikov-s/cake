const svgNamespace = "http://www.w3.org/2000/svg";

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
  const animations = new Set<Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let frame = 0;
  let pointer: { x: number; y: number } | undefined;
  let lookPosition = { x: 0, y: 0 };
  const play = (target: Element, frames: Keyframe[], duration: number) => {
    const animation = target.animate(frames, { duration, easing: "ease-in-out" });
    animations.add(animation);
    animation.onfinish = () => {
      animations.delete(animation);
      animation.cancel();
    };
  };
  const blink = () => {
    for (const eye of eyes) {
      const box = eye.getBBox();
      const y = box.y + box.height / 2;
      play(
        eye,
        [
          { transform: `translateY(${y}px) scaleY(1) translateY(${-y}px)` },
          { transform: `translateY(${y}px) scaleY(0.08) translateY(${-y}px)`, offset: 0.45 },
          { transform: `translateY(${y}px) scaleY(1) translateY(${-y}px)` },
        ],
        180,
      );
    }
  };
  const glance = () => {
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
  const bodyMotion = (motion: string[]) => {
    play(
      hop,
      motion.map((transform) => ({
        transform: `translate(50px, 50px) ${transform} translate(-50px, -50px)`,
      })),
      700,
    );
  };
  const hopMotion = () => bodyMotion(["translateY(0)", "translateY(-3px)", "translateY(0)"]);
  const wobble = () =>
    bodyMotion(["rotate(0deg)", "rotate(-4deg)", "rotate(3deg)", "rotate(0deg)"]);
  const squashAndStretch = () =>
    bodyMotion(["scale(1)", "scale(1.025, 0.96)", "scale(0.985, 1.02)", "scale(1)"]);
  const scheduleBetween = (action: () => void, minimum: number, maximum: number) => {
    const scheduleNext = () => {
      let timer: ReturnType<typeof setTimeout>;
      timer = setTimeout(
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
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const animation of animations) animation.cancel();
    animations.clear();
    resetLook();
  };
  const refresh = () => {
    stop();
    if (reduced.matches || document.hidden) return;
    scheduleBetween(blink, 5_000, 8_000);
    scheduleBetween(glance, 11_000, 15_000);
    scheduleBetween(hopMotion, 20_000, 30_000);
    scheduleBetween(wobble, 20_000, 30_000);
    scheduleBetween(squashAndStretch, 20_000, 30_000);
  };
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("blur", resetLook);
  document.documentElement.addEventListener("pointerleave", resetLook);
  document.addEventListener("visibilitychange", refresh);
  reduced.addEventListener("change", refresh);
  refresh();
  return () => {
    stop();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("blur", resetLook);
    document.documentElement.removeEventListener("pointerleave", resetLook);
    document.removeEventListener("visibilitychange", refresh);
    reduced.removeEventListener("change", refresh);
  };
}
