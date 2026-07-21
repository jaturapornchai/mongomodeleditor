// app/wiki-data.ts — เตรียมข้อมูลสำหรับหน้า wiki viewer: รวมทุก diagram ของ project
// แล้วผลิตไฟล์ markdown (toWiki) + โมเดลกราฟ (nodes/edges สำหรับวาด interactive graph)
// ใช้โดย app/wiki/[project]/page.tsx (server)

import { getProject } from "./store";
import {
  hasChildren,
  toWiki,
  wikiSafe,
  type Field,
  type GenNode,
  type CollectionData,
  type EdgeRelData,
} from "./schema";

export type WikiGraphNode = {
  id: string; // ใช้อ้างในกราฟ
  label: string;
  kind: "collection" | "type";
  note: string; // path ของ note ใน files (คลิกแล้วเปิดได้)
};
export type WikiGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "reference" | "embed" | "contain";
  label?: string;
};
export type WikiData = {
  project: string;
  files: Record<string, string>;
  gNodes: WikiGraphNode[];
  gEdges: WikiGraphEdge[];
};

type NodeLike = { id: string; data: CollectionData };
type EdgeLike = {
  id?: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: EdgeRelData;
};

const CARD_TEXT: Record<string, string> = { "1-1": "1:1", "1-n": "1:N", "n-n": "N:N" };

/** เดิน field หา nested (Object / Array<Object> ที่มี children) → type node + contain edge */
function collectTypes(
  collLabel: string,
  collFile: string,
  fields: Field[],
  pathPrefix: string,
  gNodes: WikiGraphNode[],
  gEdges: WikiGraphEdge[],
): void {
  for (const f of fields) {
    if (!hasChildren(f)) continue;
    const path = pathPrefix ? `${pathPrefix}.${f.name}` : f.name;
    const typeId = `${collLabel}__${path}`;
    const parentId = pathPrefix ? `${collLabel}__${pathPrefix}` : collLabel;
    gNodes.push({
      id: typeId,
      label: f.name + (f.type === "Array" ? "[]" : ""),
      kind: "type",
      note: `types/${collFile}__${wikiSafe(path)}.md`,
    });
    gEdges.push({ id: `c_${parentId}_${typeId}`, source: parentId, target: typeId, kind: "contain" });
    collectTypes(collLabel, collFile, f.children ?? [], path, gNodes, gEdges);
  }
}

/** โหลด project แล้วเตรียมข้อมูล wiki ทั้งชุด — null = ไม่พบ project */
export async function getWikiData(project: string): Promise<WikiData | null> {
  const p = await getProject(project);
  if (!p) return null;

  // รวมทุก diagram ใน project — dedupe collection ตาม label (first-wins)
  const nodes: GenNode[] = [];
  const edges: EdgeLike[] = [];
  const seen = new Set<string>();
  for (const t of p.tabs) {
    const d = p.diagrams[t.id];
    if (!d) continue;
    for (const n of d.nodes as NodeLike[]) {
      const label = n.data.label || "collection";
      if (seen.has(label)) continue;
      seen.add(label);
      nodes.push({ id: n.id, data: n.data });
    }
    for (const e of d.edges as EdgeLike[]) edges.push(e);
  }

  const files = toWiki(nodes, edges, project);

  // โมเดลกราฟ: collection + type + ความสัมพันธ์
  const gNodes: WikiGraphNode[] = [];
  const gEdges: WikiGraphEdge[] = [];
  const idByNodeId = new Map<string, string>(); // diagram node id → graph id (label)
  for (const n of nodes) {
    const label = n.data.label || "collection";
    idByNodeId.set(n.id, label);
    const collFile = wikiSafe(label);
    gNodes.push({ id: label, label, kind: "collection", note: `collections/${collFile}.md` });
    collectTypes(label, collFile, n.data.fields, "", gNodes, gEdges);
  }
  for (const e of edges) {
    if (!e.sourceHandle || !e.sourceHandle.endsWith("-s")) continue;
    const source = idByNodeId.get(e.source);
    const target = idByNodeId.get(e.target);
    if (!source || !target) continue;
    const src = nodes.find((n) => n.id === e.source);
    const fieldName = src?.data.fields.find((f) => f.id === e.sourceHandle!.slice(0, -2))?.name;
    const card = e.data?.cardinality ? ` · ${CARD_TEXT[e.data.cardinality] ?? e.data.cardinality}` : "";
    gEdges.push({
      id: e.id ?? `e_${source}_${target}`,
      source,
      target,
      kind: e.data?.kind === "embed" ? "embed" : "reference",
      label: fieldName ? `${fieldName}${card}` : undefined,
    });
  }

  return { project, files, gNodes, gEdges };
}
