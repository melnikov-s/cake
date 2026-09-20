/* oxlint-disable anti-slop/no-shape-in-symbol-names -- Shape is the drawing-domain entity. */
import type {
  DrawDiagnostic,
  DrawDiagramEdge,
  DrawDiagramInput,
  DrawDiagramNode,
  DrawSemanticShapeMapping,
  DrawValidationCheck,
} from "../../domain/draw/draw-editor";

interface DrawDiagramNodeLayout extends DrawDiagramNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DrawDiagramGroupLayout {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DrawDiagramLayout {
  readonly nodes: readonly DrawDiagramNodeLayout[];
  readonly groups: readonly DrawDiagramGroupLayout[];
  readonly edges: readonly DrawDiagramEdge[];
  readonly diagnostics: readonly DrawDiagnostic[];
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 88;
const RANK_GAP = 140;
const LANE_GAP = 64;
const GROUP_PADDING = 42;
const GROUP_TITLE_HEIGHT = 40;

/** Conservative deterministic text dimensions used before Excalidraw performs final font fitting. */
function estimateDrawTextSize(value: string, fontSize = 20, maximumWidth = 520) {
  const lineHeight = fontSize * 1.25;
  const averageGlyph = fontSize * 0.62;
  const naturalLines = value.split("\n");
  let visualLines = 0;
  let widest = 0;
  for (const line of naturalLines) {
    const naturalWidth = Math.max(averageGlyph, Array.from(line).length * averageGlyph);
    const wraps = Math.max(1, Math.ceil(naturalWidth / maximumWidth));
    visualLines += wraps;
    widest = Math.max(widest, Math.min(maximumWidth, naturalWidth));
  }
  return {
    width: Math.ceil(widest),
    height: Math.ceil(Math.max(lineHeight, visualLines * lineHeight)),
  };
}

function assertUnique(values: readonly string[], kind: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate diagram ${kind} ID: ${value}`);
    seen.add(value);
  }
}

function rankNodes(nodes: readonly DrawDiagramNode[], edges: readonly DrawDiagramEdge[]) {
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const incoming = new Map(nodes.map(({ id }) => [id, 0]));
  const outgoing = new Map(nodes.map(({ id }) => [id, new Array<string>()]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`Diagram edge ${edge.id} has unknown from node`);
    if (!nodeIds.has(edge.to)) throw new Error(`Diagram edge ${edge.id} has unknown to node`);
    if (edge.from === edge.to) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = nodes.filter(({ id }) => incoming.get(id) === 0).map(({ id }) => id);
  const ranks = new Map(nodes.map(({ id }) => [id, 0]));
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  // Cycles remain editable and deterministic; place their members in successive ranks.
  if (visited !== nodes.length) {
    let rank = Math.max(0, ...ranks.values());
    for (const node of nodes) {
      if ((incoming.get(node.id) ?? 0) > 0) ranks.set(node.id, ++rank);
    }
  }
  return ranks;
}

function rectanglesOverlap(left: DrawDiagramNodeLayout, right: DrawDiagramNodeLayout) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function crossingCount(nodes: readonly DrawDiagramNodeLayout[], edges: readonly DrawDiagramEdge[]) {
  const centers = new Map(
    nodes.map((node) => [node.id, { x: node.x + node.width / 2, y: node.y + node.height / 2 }]),
  );
  const orientation = (a: { x: number; y: number }, b: typeof a, c: typeof a) =>
    (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  let crossings = 0;
  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    const left = edges[leftIndex]!;
    const a = centers.get(left.from)!;
    const b = centers.get(left.to)!;
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      const right = edges[rightIndex]!;
      if ([right.from, right.to].some((id) => id === left.from || id === left.to)) continue;
      const c = centers.get(right.from)!;
      const d = centers.get(right.to)!;
      if (
        orientation(a, b, c) * orientation(a, b, d) < 0 &&
        orientation(c, d, a) * orientation(c, d, b) < 0
      )
        crossings += 1;
    }
  }
  return crossings;
}

function diagnosticsFor(
  checks: readonly DrawValidationCheck[],
  nodes: readonly DrawDiagramNodeLayout[],
  edges: readonly DrawDiagramEdge[],
): DrawDiagnostic[] {
  const diagnostics: DrawDiagnostic[] = [];
  if (checks.includes("overlaps")) {
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        if (rectanglesOverlap(nodes[left]!, nodes[right]!))
          diagnostics.push({
            check: "overlaps",
            severity: "error",
            message: "Node bounds overlap after layout.",
            semanticIds: [nodes[left]!.id, nodes[right]!.id],
          });
      }
    }
  }
  if (checks.includes("dangling-edges")) {
    const ids = new Set(nodes.map(({ id }) => id));
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to))
        diagnostics.push({
          check: "dangling-edges",
          severity: "error",
          message: "An edge endpoint does not resolve to a node.",
          semanticIds: [edge.id],
        });
    }
  }
  if (checks.includes("crossing-edges")) {
    const crossings = crossingCount(nodes, edges);
    if (crossings > Math.max(2, edges.length / 3))
      diagnostics.push({
        check: "crossing-edges",
        severity: "warning",
        message: `${crossings} edge crossings remain; consider changing direction or splitting the graph.`,
        semanticIds: [],
      });
  }
  if (checks.includes("excessive-whitespace") && nodes.length > 1) {
    const minX = Math.min(...nodes.map(({ x }) => x));
    const minY = Math.min(...nodes.map(({ y }) => y));
    const maxX = Math.max(...nodes.map(({ x, width }) => x + width));
    const maxY = Math.max(...nodes.map(({ y, height }) => y + height));
    const occupied = nodes.reduce((sum, node) => sum + node.width * node.height, 0);
    if ((maxX - minX) * (maxY - minY) > occupied * 12)
      diagnostics.push({
        check: "excessive-whitespace",
        severity: "warning",
        message: "The diagram has substantial empty space relative to its nodes.",
        semanticIds: [],
      });
  }
  return diagnostics;
}

export function layoutDrawDiagram(input: DrawDiagramInput): DrawDiagramLayout {
  const groups = input.groups ?? [];
  const edges = input.edges ?? [];
  assertUnique(
    input.nodes.map(({ id }) => id),
    "node",
  );
  assertUnique(
    groups.map(({ id }) => id),
    "group",
  );
  assertUnique(
    edges.map(({ id }) => id),
    "edge",
  );
  const groupIds = new Set(groups.map(({ id }) => id));
  for (const node of input.nodes) {
    if (node.groupId && !groupIds.has(node.groupId))
      throw new Error(`Diagram node ${node.id} has unknown group ${node.groupId}`);
  }
  const ranks = rankNodes(input.nodes, edges);
  const lanes = new Map<number, number>();
  const nodes = input.nodes.map((node): DrawDiagramNodeLayout => {
    const label = estimateDrawTextSize(
      node.label,
      20,
      Math.max(80, (node.width ?? NODE_WIDTH) - 40),
    );
    const width = node.width ?? Math.max(NODE_WIDTH, Math.min(560, label.width + 40));
    const height = Math.max(node.height ?? NODE_HEIGHT, label.height + 32);
    const rank = ranks.get(node.id) ?? 0;
    const lane = lanes.get(rank) ?? 0;
    lanes.set(rank, lane + 1);
    return {
      ...node,
      width,
      height,
      x:
        input.direction === "left-to-right"
          ? rank * (NODE_WIDTH + RANK_GAP)
          : lane * (NODE_WIDTH + LANE_GAP),
      y:
        input.direction === "left-to-right"
          ? lane * (NODE_HEIGHT + LANE_GAP)
          : rank * (NODE_HEIGHT + RANK_GAP),
    };
  });
  const groupLayouts = groups.map((group): DrawDiagramGroupLayout => {
    const children = nodes.filter(({ groupId }) => groupId === group.id);
    if (children.length === 0) throw new Error(`Diagram group ${group.id} has no nodes`);
    const minX = Math.min(...children.map(({ x }) => x));
    const minY = Math.min(...children.map(({ y }) => y));
    const maxX = Math.max(...children.map(({ x, width }) => x + width));
    const maxY = Math.max(...children.map(({ y, height }) => y + height));
    const title = estimateDrawTextSize(group.label, 20, Math.max(160, maxX - minX));
    return {
      ...group,
      x: minX - GROUP_PADDING,
      y: minY - GROUP_PADDING - Math.max(GROUP_TITLE_HEIGHT, title.height),
      width: Math.max(maxX - minX + GROUP_PADDING * 2, title.width + GROUP_PADDING * 2),
      height: maxY - minY + GROUP_PADDING * 2 + Math.max(GROUP_TITLE_HEIGHT, title.height),
    };
  });
  return {
    nodes,
    groups: groupLayouts,
    edges,
    diagnostics: diagnosticsFor(input.validate ?? [], nodes, edges),
  };
}

export function diagramShapeId(
  diagramId: string,
  role: DrawSemanticShapeMapping["role"],
  semanticId: string,
) {
  const suffix = `${diagramId}--${role}--${semanticId}`;
  if (suffix.length > 256) throw new Error("Diagram and semantic IDs are too long when combined");
  return `shape:${suffix}`;
}
