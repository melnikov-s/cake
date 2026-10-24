import DOMPurify from "dompurify";
import {
  diagramSourceLimit,
  diagramTimeoutMs,
  type DiagramRequest,
  type DiagramResponse,
} from "./diagram-contract";

/** Each job owns a worker so an expensive diagram can be stopped without
 * blocking the transcript or cancelling another visible diagram. */
export function requestDiagram(request: DiagramRequest, signal: AbortSignal): Promise<string> {
  if (request.source.length > diagramSourceLimit)
    return Promise.reject(
      new Error(`Diagram exceeds ${diagramSourceLimit.toLocaleString()} characters.`),
    );
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("../workers/diagram.worker.ts", import.meta.url), {
      type: "module",
      name: "cake-diagram",
    });
    const finish = (response: DiagramResponse) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (response.error !== undefined) reject(new Error(response.error));
      else resolve(response.svg);
    };
    const cancel = () => finish({ error: "Diagram rendering cancelled." });
    const timeout = setTimeout(
      () => finish({ error: "Diagram rendering exceeded five seconds. Simplify the diagram." }),
      diagramTimeoutMs,
    );
    signal.addEventListener("abort", cancel, { once: true });
    worker.addEventListener(
      "message",
      (event: MessageEvent<DiagramResponse>) => finish(event.data),
      { once: true },
    );
    worker.addEventListener("error", () => finish({ error: "Diagram renderer failed to load." }), {
      once: true,
    });
    worker.addEventListener(
      "messageerror",
      () => finish({ error: "Diagram renderer returned an unreadable result." }),
      { once: true },
    );
    worker.postMessage(request);
  });
}

/** SVG-only defense in depth after Pele's own escaping/style filtering. No
 * authored HTML, external resources, CSS imports, or executable markup enters
 * the transcript. Local SVG paint references (gradients, markers) are retained. */
export function sanitizeDiagram(svg: string): string {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      "style",
      "image",
      "feImage",
      "foreignObject",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
      "use",
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:|cake:\/\/(?:session|subagent|artifact)\/|[^:]*$)/i,
  });
  for (const element of fragment.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (
        (/^(?:href|xlink:href)$/i.test(attribute.name) &&
          element.localName !== "a" &&
          !/^#[a-z0-9_-]+$/i.test(attribute.value)) ||
        /@import/i.test(attribute.value) ||
        Array.from(attribute.value.matchAll(/url\s*\(([^)]*)\)/gi)).some(
          (match) => !/^[\s"']*#[a-z0-9_-]+[\s"']*$/i.test(match[1] ?? ""),
        )
      )
        element.removeAttribute(attribute.name);
    }
    if (element.localName === "a") {
      const href = element.getAttribute("href") ?? element.getAttribute("xlink:href");
      if (href && !isDiagramHref(href)) {
        element.removeAttribute("href");
        element.removeAttribute("xlink:href");
      }
      element.removeAttribute("target");
    }
  }
  const root = fragment.querySelector("svg");
  if (!root) throw new Error("Diagram renderer did not produce SVG.");
  pairNodeColors(root);
  return root.outerHTML;
}

/** Pele applies authored fills to shapes, but leaves unspecified label colors
 * inheriting the SVG's theme foreground. Pair those labels with their actual
 * fill instead. CSS keeps variable-based fills live across theme changes; an
 * explicit author-supplied label color still takes precedence. */
function pairNodeColors(root: Element) {
  for (const node of root.querySelectorAll<SVGElement>(".pele-node")) {
    const background = node.querySelector<SVGElement>(
      "rect[style], circle[style], ellipse[style], path[style], polygon[style]",
    );
    const fill = background?.style.fill;
    if (!fill || /^(?:none|transparent)$/i.test(fill)) continue;
    const foreground = `contrast-color(${fill})`;
    node.style.fill = foreground;
    node.style.color = foreground;
  }
}

export function isDiagramHref(href: string) {
  return (
    !!href &&
    !Array.from(href).some((character) => character.charCodeAt(0) <= 32 || character === "\\") &&
    !href.startsWith("//") &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(href) ||
      /^(?:https?:|cake:\/\/(?:session|subagent|artifact)\/)/i.test(href))
  );
}
