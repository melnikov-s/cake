/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagramTimeoutMs, type DiagramRequest } from "../../../src/renderer/lib/diagram-contract";
import { renderDiagram } from "../../../src/renderer/lib/diagram-engine";
import {
  isDiagramHref,
  requestDiagram,
  sanitizeDiagram,
} from "../../../src/renderer/lib/diagram-rendering";

const request = (source: string): DiagramRequest => ({
  source,
  maxWidth: 800,
  fontFamily: "sans-serif",
  fontFamilyMono: "monospace",
  idPrefix: "test-diagram",
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Pele diagram boundary", () => {
  it.each([
    [
      "flowchart",
      'flowchart LR\nsubgraph App\n A["**Draft**"] --> B[Review]\nend\nB --> C[Done]\nclassDef ready fill:#abc\nclass C ready',
    ],
    [
      "sequence",
      "sequenceDiagram\nparticipant A as Alice\nparticipant B as Bob\nA->>B: Hello\nloop Work\nB-->>A: Ready\nend",
    ],
    ["class", "classDiagram\nAnimal <|-- Duck\nAnimal : +int age\nDuck : +quack()"],
    ["state", "stateDiagram-v2\n[*] --> Draft\nDraft --> Done\nDone --> [*]"],
    ["ER", "erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\n string name\n}"],
    [
      "gantt",
      "gantt\ndateFormat YYYY-MM-DD\nsection Work\nDraft :a, 2026-01-01, 2d\nReview :after a, 1d",
    ],
    [
      "git",
      "gitGraph\ncommit\nbranch develop\ncheckout develop\ncommit\ncheckout main\nmerge develop",
    ],
    ["pie", 'pie title Usage\n"Code" : 60\n"Review" : 40'],
    ["mindmap", "mindmap\n root((Cake))\n  Chat\n  Artifacts"],
    ["timeline", "timeline\ntitle Release\n2026 : Draft : Ship"],
    ["journey", "journey\ntitle Review\nsection Work\nRead: 5: Alice\nApprove: 4: Bob"],
    [
      "quadrant",
      "quadrantChart\ntitle Priority\nx-axis Low --> High\ny-axis Low --> High\nTask: [0.3, 0.6]",
    ],
    ["XY", "xychart-beta\nx-axis [Jan, Feb, Mar]\ny-axis 0 --> 100\nbar [30, 50, 80]"],
    ["sankey", "sankey-beta\n\nInput,Output,10"],
    ["block", 'block-beta\ncolumns 2\na["Start"] b["Done"]\na --> b'],
    [
      "architecture",
      "architecture-beta\nservice api(server)[API]\nservice db(database)[Database]\napi:R -- L:db",
    ],
    ["packet", 'packet-beta\n0-7: "Header"\n8-15: "Body"'],
    [
      "frontmatter",
      '---\ntitle: Pipeline\nconfig:\n  theme: dark\n---\n%%{init: {"theme":"forest"}}%%\nflowchart TB\naccTitle: Pipeline\naccDescr: Draft to done\nA --> B',
    ],
  ])("renders representative %s syntax as sanitized SVG", (_type, source) => {
    const result = renderDiagram(request(source));
    expect(result.error).toBeUndefined();
    const svg = sanitizeDiagram(result.svg!);
    expect(svg).toContain('class="pele ');
    expect(svg).toContain("viewBox=");
    expect(svg).not.toContain("foreignObject");
  });

  it("pairs class and inline custom fills with a contrasting default foreground", () => {
    const result = renderDiagram(
      request(
        "flowchart LR\nA[Normal] --> B[Runtime] --> C[Visible] --> D[Dark]\nclassDef runtime fill:#fff2cc,stroke:#d6b656\nclass B runtime\nstyle C fill:#d5e8d4,stroke:#82b366\nstyle D fill:#17365d",
      ),
    );
    expect(result.error).toBeUndefined();
    const doc = new DOMParser().parseFromString(sanitizeDiagram(result.svg!), "text/html");
    expect(doc.querySelector('[data-id="A"]')?.getAttribute("style")).toBeNull();
    for (const [id, fill] of [
      ["B", "#fff2cc"],
      ["C", "#d5e8d4"],
      ["D", "#17365d"],
    ]) {
      const node = doc.querySelector<SVGElement>(`.pele-node[data-id="${id}"]`)!;
      expect(node.style.fill).toBe(`contrast-color(${fill})`);
      expect(node.querySelector<SVGElement>("rect")!.style.fill).toBe(fill);
      expect(node.querySelector(".pele-label")?.getAttribute("style")).toBeNull();
    }
    expect(doc.querySelector<SVGElement>('[data-id="B"] rect')!.style.stroke).toBe("#d6b656");
  });

  it("preserves explicit label colors, transparent nodes and the live SVG theme", () => {
    const result = renderDiagram(
      request(
        "flowchart LR\nA[Authored] --> B[Transparent] --> C[Named color]\nstyle A fill:#fff2cc,color:#543800\nstyle B fill:transparent\nstyle C fill:rebeccapurple",
      ),
    );
    expect(result.error).toBeUndefined();
    const doc = new DOMParser().parseFromString(sanitizeDiagram(result.svg!), "text/html");
    expect(doc.querySelector<SVGElement>('[data-id="A"] .pele-label')!.style.fill).toBe("#543800");
    expect(doc.querySelector('[data-id="B"]')?.getAttribute("style")).toBeNull();
    expect(doc.querySelector<SVGElement>('.pele-node[data-id="C"]')!.style.fill).toBe(
      "contrast-color(rebeccapurple)",
    );
    expect(doc.querySelector("svg")?.getAttribute("style")).toContain("--_fg:var(--pele-fg,");
  });

  it("keeps Cake's theme authoritative over Mermaid theme directives", () => {
    const source = "flowchart LR\nA[Normal] --> B[Custom]\nstyle B fill:#fff2cc";
    const plain = renderDiagram(request(source));
    const themed = renderDiagram(
      request(
        '%%{init: {"theme":"dark","themeVariables":{"primaryColor":"#ff0000","primaryTextColor":"#fff"}}}%%\n' +
          source,
      ),
    );
    expect(themed.error).toBeUndefined();
    expect(sanitizeDiagram(themed.svg!)).toBe(sanitizeDiagram(plain.svg!));
  });

  it("keeps math readable without trusting an HTML/math or custom icon resolver", () => {
    const result = renderDiagram(request('flowchart LR\nA["$$x^2$$"] --> B[fa:fa-car Vehicle]'));
    expect(result.error).toBeUndefined();
    const doc = new DOMParser().parseFromString(sanitizeDiagram(result.svg!), "text/html");
    expect(doc.body.textContent).toContain("x^2");
    expect(doc.body.textContent).toContain("Vehicle");
    expect(doc.querySelector("foreignObject, image")).toBeNull();
  });

  it("treats labels, directives, links, images and callbacks as untrusted", () => {
    const result = renderDiagram(
      request(
        '%%{init: {"securityLevel":"loose","images":true}}%%\nflowchart LR\nA["<script>alert(1)</script>"] --> B@{ img: "https://untrusted.example/track.svg", label: "Remote" }\nclick A "javascript:alert(1)"\nclick B callback',
      ),
    );
    expect(result.error).toBeUndefined();
    const doc = new DOMParser().parseFromString(sanitizeDiagram(result.svg!), "text/html");
    expect(doc.querySelector("script, image, foreignObject, [onclick], a[href] ")).toBeNull();
    expect(doc.body.textContent).toContain("alert(1)");
  });

  it("sanitizes SVG independently, retaining local gradients and approved navigation only", () => {
    const clean = sanitizeDiagram(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><style>@import "https://evil.test";</style><foreignObject><div>bad</div></foreignObject><image href="https://evil.test/a"/><filter><feImage href="https://evil.test/filter"/></filter><linearGradient href="https://evil.test/paint"/><path onload="alert(1)" style="fill:url(https://evil.test/a)"/><rect fill="url(#gradient)"/><a href="cake://session/session-1"><text>Cake</text></a><a href="//evil.test"><text>Bad</text></a><a href="file:///private"><text>File</text></a></svg>',
    );
    const doc = new DOMParser().parseFromString(clean, "text/html");
    expect(doc.querySelector("script, style, image, feImage, foreignObject, [onload]")).toBeNull();
    expect(doc.querySelector("path")?.getAttribute("style")).toBeNull();
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe("url(#gradient)");
    expect(doc.querySelector("linearGradient")?.getAttribute("href")).toBeNull();
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("cake://session/session-1");
    expect(Array.from(doc.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual([
      "cake://session/session-1",
      null,
      null,
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "vbscript:bad",
    "file:///private",
    "mailto:user@example.com",
    "tel:1234",
    "//host/path",
    "https:\\evil.test",
    "java\nscript:bad",
  ])("blocks navigation to %s", (href) => {
    expect(isDiagramHref(href)).toBe(false);
  });

  it("enforces source and edge limits", async () => {
    expect(renderDiagram(request("flowchart LR\n" + "A --> B\n".repeat(1001))).error).toBeDefined();
    expect(renderDiagram(request("x".repeat(50_001))).error).toBeDefined();
    await expect(
      requestDiagram(request("x".repeat(50_001)), new AbortController().signal),
    ).rejects.toThrow("50,000");
  });

  it("terminates stalled and obsolete workers without affecting another diagram", async () => {
    vi.useFakeTimers();
    const workers: StalledWorker[] = [];
    class StalledWorker extends EventTarget {
      terminate = vi.fn();
      postMessage() {}
      constructor() {
        super();
        workers.push(this);
      }
    }
    vi.stubGlobal("Worker", StalledWorker);
    const abort = new AbortController();
    const obsolete = requestDiagram(request("flowchart LR\nA --> B"), abort.signal);
    const stalled = requestDiagram(request("flowchart LR\nC --> D"), new AbortController().signal);
    const cancelled = expect(obsolete).rejects.toThrow("cancelled");
    const timedOut = expect(stalled).rejects.toThrow("five seconds");
    abort.abort();
    await cancelled;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[1]!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(diagramTimeoutMs);
    await timedOut;
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });
});
