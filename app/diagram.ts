import type { CollectionData, GenEdge, GenNode } from "./schema";

/** รวมเฉพาะ mapping ระหว่าง keygroup คู่เดียวกันและ semantics เดียวกัน */
export function compositeRelationGroups<T extends GenEdge & { id: string }>(
  nodes: GenNode[],
  edges: T[],
): T[][] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<string, T[]>();
  for (const edge of edges) {
    const sourceId = edge.sourceHandle?.replace(/-s(-[lr])?$/, "");
    const targetId = edge.targetHandle?.replace(/-t(-[lr])?$/, "");
    const sourceGroup = nodeById.get(edge.source)?.data.fields.find((field) => field.id === sourceId)?.keygroup;
    const targetGroup = nodeById.get(edge.target)?.data.fields.find((field) => field.id === targetId)?.keygroup;
    if (!sourceGroup || !targetGroup) continue;
    const key = JSON.stringify([
      edge.source,
      sourceGroup,
      edge.target,
      targetGroup,
      edge.data?.kind ?? "reference",
      edge.data?.cardinality ?? "1-n",
    ]);
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** สร้าง id เส้นสรุปที่ไม่ชน raw edge; mapping นี้ derive ใหม่และห้ามอ่านจากไฟล์ import */
export function compositeRenderGroups<T extends GenEdge & { id: string }>(
  nodes: GenNode[],
  edges: T[],
): { id: string; edges: T[] }[] {
  const used = new Set(edges.map((edge) => edge.id));
  return compositeRelationGroups(nodes, edges).map((members) => {
    const base = `composite:${members[0].id}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}:${n}`;
    used.add(id);
    return { id, edges: members };
  });
}

/** ตัด state ชั่วคราวของ React Flow ก่อนเก็บ local/server/history */
export function persistedFlowDiagram<
  N extends { selected?: boolean; dragging?: boolean; measured?: unknown; resizing?: boolean },
  E extends { selected?: boolean; label?: unknown },
>(nodes: N[], edges: E[]): { nodes: N[]; edges: E[] } {
  return {
    nodes: nodes.map((node) => ({
      ...node,
      selected: undefined,
      dragging: undefined,
      measured: undefined,
      resizing: undefined,
    })),
    edges: edges.map((edge) => ({ ...edge, selected: undefined, label: undefined })),
  };
}

/** รับ index แบบทีละบรรทัดหรือ comma โดยให้ชื่อ field ที่มี comma ตรงตัวชนะก่อน */
export function indexInputRows(text: string, resolvesExactly: (value: string) => boolean): string[] {
  return text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (resolvesExactly(line)) return [line];
      const parts = line.split(",").map((value) => value.trim()).filter(Boolean);
      return parts.length > 1 ? parts : [line];
    });
}

export function fieldByHandle(
  node: { data: CollectionData } | undefined,
  handle: string | null | undefined,
): string {
  const id = handle?.replace(/-[st](-[lr])?$/, "");
  if (!id || !node) return "?";
  const walk = (fields: CollectionData["fields"]): string | undefined => {
    for (const field of fields) {
      if (field.id === id) return field.name;
      const nested = walk(field.children ?? []);
      if (nested) return `${field.name}.${nested}`;
    }
  };
  return walk(node.data.fields) ?? id;
}
