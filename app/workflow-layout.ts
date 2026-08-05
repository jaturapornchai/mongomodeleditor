import ELK from "elkjs/lib/elk.bundled.js";

export type WorkflowLayoutNode = {
  id: string;
  width?: number;
  height?: number;
};

export type WorkflowLayoutEdge = {
  id: string;
  source: string;
  target: string;
};

export async function layoutWorkflow(
  nodes: WorkflowLayoutNode[],
  edges: WorkflowLayoutEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  if (nodes.length === 0) return new Map();
  const ids = new Set(nodes.map((node) => node.id));
  const result = await new ELK().layout({
    id: "workflow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.nodeNode": "60",
      "elk.spacing.componentComponent": "100",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: node.width ?? 256,
      height: node.height ?? 120,
    })),
    edges: edges
      .filter((edge) => edge.source !== edge.target && ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  return new Map((result.children ?? []).map((node) => [
    node.id,
    { x: (node.x ?? 0) + 40, y: (node.y ?? 0) + 40 },
  ]));
}
