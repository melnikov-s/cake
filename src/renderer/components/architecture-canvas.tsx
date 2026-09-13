import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { cn } from "@/lib/utils";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { SourceLocation } from "../../ipc/source-location";

type ArchitectureArtifact = Extract<CakeArtifactV1, { kind: "architecture" }>;
type ArchitectureNode = ArchitectureArtifact["payload"]["nodes"][number];

const NODE_WIDTH = 220;
const NODE_HEIGHT = 84;
const elk = new ELK();
type ArchitectureGroupFlowNode = Node<{ label: string }, "architectureGroup">;
const architectureNodeTypes = { architectureGroup: ArchitectureGroupNode };

export function ArchitectureCanvas({
  artifact,
  onOpenSourceLocation,
}: {
  artifact: ArchitectureArtifact;
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const flow = useRef<ReactFlowInstance<Node, Edge>>(null);
  const graph = artifact.payload;

  useEffect(() => {
    let active = true;
    setError(undefined);
    void layoutGraph(graph)
      .then((layout) => {
        if (!active) return;
        setNodes(layout.nodes);
        setEdges(layout.edges);
        requestAnimationFrame(() => flow.current?.fitView({ padding: 0.16, duration: 0 }));
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [graph]);

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId),
    [graph.nodes, selectedId],
  );

  if (error)
    return (
      <Callout variant="error">
        <strong>Architecture diagram could not render</strong>
        <span className="text-xs">{error}</span>
      </Callout>
    );

  return (
    <div className="flex h-full min-h-96 flex-col overflow-hidden rounded-lg border border-border bg-background">
      <div className="min-h-80 flex-1">
        <ReactFlow
          className="relative size-full min-h-80 overflow-hidden [--xy-controls-button-background-color:var(--card)] [--xy-controls-button-border-color:var(--border)] [--xy-controls-button-color:var(--card-foreground)] [--xy-edge-label-background-color:var(--card)] [--xy-edge-label-color:var(--card-foreground)] [--xy-minimap-background-color:var(--card)] [--xy-node-background-color:var(--card)] [--xy-node-border:2px_solid_var(--border)] [--xy-node-color:var(--card-foreground)]"
          nodes={nodes}
          edges={edges}
          nodeTypes={architectureNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          onInit={(instance) => {
            flow.current = instance;
            requestAnimationFrame(() => instance.fitView({ padding: 0.16, duration: 0 }));
          }}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onNodeClick={(_, node) => {
            if (node.type !== "architectureGroup") setSelectedId(node.id);
          }}
          onPaneClick={() => setSelectedId(undefined)}
          aria-label={artifact.title ?? "Architecture diagram"}
        >
          <Background gap={22} size={1} />
          <MiniMap pannable zoomable className="h-20! w-28! border border-border bg-card!" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selected && (
        <div className="flex items-start gap-3 border-t border-border bg-card px-3 py-2.5 text-xs">
          <div className="min-w-0 flex-1">
            <strong className="text-foreground">{selected.label}</strong>
            <span className="ml-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {selected.category ?? "module"}
            </span>
            {selected.description && (
              <p className="mt-1 text-muted-foreground">{selected.description}</p>
            )}
          </div>
          {selected.source && onOpenSourceLocation && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenSourceLocation(selected.source!)}
            >
              Open source
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

async function layoutGraph(graph: ArchitectureArtifact["payload"]) {
  const direction = graph.direction ?? "LR";
  const nodeLayoutInput = (node: ArchitectureNode): ElkNode => ({
    id: node.id,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  });
  const groupedIds = new Set(graph.nodes.flatMap((node) => (node.group ? [node.id] : [])));
  const { sourcePosition, targetPosition } = handlePositions(direction);
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: [
      ...(graph.groups ?? []).flatMap((group) => {
        const children = graph.nodes.filter((node) => node.group === group.id);
        return children.length === 0
          ? []
          : [
              {
                id: group.id,
                layoutOptions: {
                  "elk.direction": direction,
                  "elk.padding": "[top=52,left=28,bottom=28,right=28]",
                  "elk.layered.spacing.nodeNodeBetweenLayers": "112",
                },
                children: children.map(nodeLayoutInput),
              },
            ];
      }),
      ...graph.nodes.filter((node) => !groupedIds.has(node.id)).map(nodeLayoutInput),
    ],
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  });

  const rootNodes = new Map((result.children ?? []).map((node) => [node.id, node]));
  const groupNodes: Node[] = (graph.groups ?? []).flatMap((group) => {
    const layout = rootNodes.get(group.id);
    if (!layout) return [];
    return [
      {
        id: group.id,
        type: "architectureGroup",
        position: { x: layout.x ?? 0, y: layout.y ?? 0 },
        data: { label: group.label },
        selectable: false,
        draggable: false,
        zIndex: 0,
        className:
          "rounded-xl border border-dashed border-border bg-muted/35 text-muted-foreground",
        style: { width: layout.width, height: layout.height },
      },
    ];
  });
  const nodes: Node[] = [
    ...groupNodes,
    ...graph.nodes.map((node) => {
      const parent = node.group ? rootNodes.get(node.group) : undefined;
      const layout =
        parent?.children?.find((child) => child.id === node.id) ?? rootNodes.get(node.id);
      return {
        id: node.id,
        position: { x: layout?.x ?? 0, y: layout?.y ?? 0 },
        data: { label: node.label },
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        parentId: parent ? node.group : undefined,
        sourcePosition,
        targetPosition,
        className: nodeClassName(node.category),
        zIndex: 1,
      };
    }),
  ];
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    className: edge.kind === "control" ? "stroke-foreground" : "stroke-muted-foreground",
  }));
  return { nodes, edges };
}

function ArchitectureGroupNode({ data }: NodeProps<ArchitectureGroupFlowNode>) {
  return (
    <span className="absolute top-3 left-3 text-[10px] font-semibold tracking-wide uppercase">
      {data.label}
    </span>
  );
}

function handlePositions(direction: "LR" | "TB" | "RL" | "BT") {
  switch (direction) {
    case "LR":
      return { sourcePosition: Position.Right, targetPosition: Position.Left };
    case "RL":
      return { sourcePosition: Position.Left, targetPosition: Position.Right };
    case "TB":
      return { sourcePosition: Position.Bottom, targetPosition: Position.Top };
    case "BT":
      return { sourcePosition: Position.Top, targetPosition: Position.Bottom };
  }
}

function nodeClassName(category: ArchitectureNode["category"]) {
  return cn(
    "rounded-lg px-3 py-2 text-sm font-semibold shadow-sm",
    category === "external" && "[--xy-node-border:2px_dashed_var(--border)]",
    category === "database" && "[--xy-node-border:2px_solid_var(--accent)]",
    category === "process" && "[--xy-node-background-color:var(--muted)]",
  );
}
