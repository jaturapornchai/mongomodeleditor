// app/wiki/[project]/graph.tsx — กราฟความสัมพันธ์แบบ interactive (React Flow)
// collection = กล่อง sky, type (embedded) = กล่อง violet, reference = เส้น sky มีลูกเล่น, embed = ประ
"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  ReactFlow,
  type ReactFlowInstance,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WikiGraphNode, WikiGraphEdge } from "../../wiki-data";

type WikiFlowNode = Node<{ label: string; kind: "collection" | "type" }, "wiki">;

function WikiNodeView({ data }: NodeProps<WikiFlowNode>) {
  const coll = data.kind === "collection";
  return (
    <div
      className={`cursor-pointer rounded-lg border px-3.5 py-2 text-xs font-medium shadow-lg transition-transform hover:scale-105 ${
        coll
          ? "border-sky-500/80 bg-sky-950/95 text-sky-200 shadow-sky-950"
          : "border-violet-500/70 bg-violet-950/90 text-violet-200 shadow-violet-950"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-slate-600" />
      {coll ? "🗄 " : "🧩 "}
      {data.label}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-slate-600" />
    </div>
  );
}

const nodeTypes = { wiki: WikiNodeView };

/** วางตำแหน่ง: collection เป็นคอลัมน์ตามระดับอ้างอิง (เหมือนจัดผังของ designer), type เป็น satellite ของเจ้าของ */
function layout(gNodes: WikiGraphNode[], gEdges: WikiGraphEdge[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const out = new Map<string, string[]>();
  for (const e of gEdges) {
    if (e.kind !== "reference" || e.source === e.target) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  }
  const cache = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const c = cache.get(id);
    if (c !== undefined) return c;
    if (seen.has(id)) return 0;
    seen.add(id);
    const outs = out.get(id) ?? [];
    const d = outs.length ? 1 + Math.max(...outs.map((t) => depth(t, seen))) : 0;
    seen.delete(id);
    cache.set(id, d);
    return d;
  };

  const colls = gNodes.filter((n) => n.kind === "collection");
  const byDepth = new Map<number, WikiGraphNode[]>();
  for (const n of colls) {
    const d = depth(n.id, new Set());
    byDepth.set(d, [...(byDepth.get(d) ?? []), n]);
  }
  const ownerOf = new Map<string, string>(); // type id → collection id (satellite)
  for (const e of gEdges) {
    if (e.kind === "contain" && colls.some((c) => c.id === e.source)) ownerOf.set(e.target, e.source);
  }

  const GAP_X = 220,
    GAP_Y = 76;
  const satCount = new Map<string, number>();
  for (const d of [...byDepth.keys()].sort((a, b) => b - a)) {
    byDepth.get(d)!.forEach((n, i) => pos.set(n.id, { x: d * GAP_X, y: i * GAP_Y }));
  }
  // type ที่หาเจ้าของไม่เจอ (nested ชั้นลึก) ให้ตามเจ้าของชั้นบนสุด
  const rootOwner = (typeId: string): string | undefined => {
    const cur = ownerOf.get(typeId);
    if (cur) return cur;
    const parent = gEdges.find((e) => e.kind === "contain" && e.target === typeId)?.source;
    return parent ? rootOwner(parent) : undefined;
  };
  for (const n of gNodes.filter((x) => x.kind === "type")) {
    const owner = rootOwner(n.id);
    const op = owner ? pos.get(owner) : undefined;
    const idx = (satCount.get(owner ?? "") ?? 0) + 1;
    satCount.set(owner ?? "", idx);
    // satellite อยู่ใต้เจ้าของ ไม่ชนคอลัมน์ถัดไป
    pos.set(n.id, op ? { x: op.x, y: op.y + 42 + idx * 30 } : { x: 0, y: 0 });
  }
  return pos;
}

export default function WikiGraph({
  gNodes,
  gEdges,
  activeNote,
  onOpenNote,
}: {
  gNodes: WikiGraphNode[];
  gEdges: WikiGraphEdge[];
  activeNote: string | null;
  onOpenNote: (notePath: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(gNodes, gEdges);
    const nodes: WikiFlowNode[] = gNodes.map((n) => ({
      id: n.id,
      type: "wiki",
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { label: n.label, kind: n.kind },
    }));
    const edges: Edge[] = gEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.kind === "reference",
      style:
        e.kind === "reference"
          ? { stroke: "#38bdf8", strokeWidth: 1.6, animationDirection: "reverse" } // animated — กลับทิศ dash ให้วิ่งแม่→ลูก (ดู designer)
          : e.kind === "embed"
            ? { stroke: "#64748b", strokeWidth: 1.4, strokeDasharray: "6 3" }
            : { stroke: "#8b5cf6", strokeWidth: 1, opacity: 0.55 },
      labelStyle: { fill: "#94a3b8", fontSize: 10 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      // ทิศเดียวกับ designer: แม่(target) → ลูก(source) — markerStart ปลายฝั่งลูก + auto-start-reverse ให้หัวลูกศรชี้เข้าหาลูก
      markerStart: e.kind !== "contain" ? { type: MarkerType.ArrowClosed, color: e.kind === "embed" ? "#64748b" : "#38bdf8", orient: "auto-start-reverse" } : undefined,
    }));
    return { nodes, edges };
  }, [gNodes, gEdges]);

  const activeId = useMemo(() => {
    if (!activeNote) return null;
    return gNodes.find((n) => n.note === activeNote)?.id ?? null;
  }, [gNodes, activeNote]);

  const displayNodes = useMemo(
    () =>
      nodes.map((n) =>
        n.id === activeId ? { ...n, style: { outline: "2px solid #38bdf8", borderRadius: 8 } } : n
      ),
    [nodes, activeId]
  );

  // ธีมปัจจุบันอ่านจาก <html data-theme> (ตั้งโดยสคริปต์ใน layout.tsx ก่อน hydrate)
  // — กราฟนี้อยู่ได้ทั้งในแผงข้าง canvas และ route /wiki/<project> จึงพึ่ง prop จาก designer ไม่ได้
  const light = useSyncExternalStore(
    (cb) => {
      const o = new MutationObserver(cb);
      o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => o.disconnect();
    },
    () => document.documentElement.dataset.theme === "light",
    () => false,
  );

  // แผงกราฟเปลี่ยนความกว้างได้ตลอด (ย่อ/ขยายแผงข้าง canvas, สลับ 300↔380px, ลากแบ่งจอ)
  // React Flow fit ให้ครั้งเดียวตอน mount → node หลุดออกนอกกรอบทุกครั้งที่แผงแคบลง
  const wrap = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<WikiFlowNode, Edge> | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2 }));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrap} className="h-full w-full">
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        proOptions={{ hideAttribution: false }}
        onInit={(instance) => {
          flow.current = instance;
          // ตอน mount container อาจยังไม่มีขนาด — fit อีกครั้งหลัง layout นิ่ง
          setTimeout(() => instance.fitView({ padding: 0.2 }), 80);
        }}
        onNodeClick={(_, node) => {
          const gn = gNodes.find((n) => n.id === node.id);
          if (gn) onOpenNote(gn.note);
        }}
      >
        {/* สีของ grid/minimap ต้องพลิกตามธีมด้วย ไม่งั้นโหมดสว่างได้กล่องดำทับกราฟ (เหมือนฝั่ง designer) */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          color={light ? "#cbd5e1" : "#1e293b"}
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) =>
            (n as WikiFlowNode).data.kind === "collection"
              ? light
                ? "#7dd3fc"
                : "#0c4a6e"
              : light
                ? "#c4b5fd"
                : "#4c1d95"
          }
          maskColor={light ? "rgba(15,23,42,0.12)" : "rgba(2,6,23,0.75)"}
          pannable
          zoomable
        />
      </ReactFlow>
    </div>
  );
}
