"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  NodeResizeControl,
  ResizeControlVariant,
  ReactFlowProvider,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type EdgeProps,
  type EdgeMarker,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import WikiViewer from "./wiki/[project]/WikiViewer";
import type { WikiData } from "./wiki-data";
import {
  compositeRenderGroups,
  fieldByHandle,
  indexInputRows,
  persistedFlowDiagram,
} from "./diagram";
import {
  FIELD_TYPES,
  type FieldType,
  type Field,
  type CollectionData,
  type CollectionIndex,
  type EdgeRelData,
  type GenNode,
  type GenEdge,
  toMongosh,
  toMongoose,
  toTypeScript,
  toMarkdown,
  toSampleDoc,
  toGo,
  lintModel,
  lintProject,
  type ProjectLintIssue,
  toWiki,
  isThaiText,
  keyGroupsOf,
  fieldPathEntries,
  BAD_NAME_CHARS,
  demo,
} from "./schema";

// regression guard ของ schema.ts — รันเฉพาะ dev, throw ถ้า codegen พัง
if (process.env.NODE_ENV !== "production") demo();

// ---------- ชนิดข้อมูล ----------

const TYPE_ICON: Record<FieldType, string> = {
  String: "=",
  Number: "#",
  Boolean: "✓",
  Date: "⏱",
  ObjectId: "🔗",
  Array: "[ ]",
  Object: "{ }",
  Decimal128: "0.1",
  Mixed: "?",
};

type CollectionNode = Node<CollectionData, "collection">;
type RelEdge = Edge<EdgeRelData>;
type DiagramData = { nodes: CollectionNode[]; edges: RelEdge[] };
const persistedDiagramMap = (diagrams: Record<string, DiagramData>): Record<string, DiagramData> =>
  Object.fromEntries(
    Object.entries(diagrams).map(([id, diagram]) => [
      id,
      persistedFlowDiagram(diagram.nodes, diagram.edges),
    ]),
  );
type DisplayRelData = EdgeRelData & {
  compositeEdgeIds?: string[];
  hiddenComposite?: boolean;
};
type DiagramMeta = { id: string; name: string };

// สถานะ popup ป้อนรายละเอียด (แทน window.prompt)
type EditState =
  | { kind: "collDesc"; text: string; orig: string }
  | { kind: "fieldDesc"; fid: string; name: string; text: string; orig: string }
  | { kind: "enumDefault"; fid: string; name: string; enumText: string; def: string }
  | { kind: "keyGroup"; fid: string; name: string; text: string }
  | { kind: "index"; iid?: string; text: string; unique: boolean; sparse: boolean };

const uid = () => crypto.randomUUID().slice(0, 8);
const INDEX_KEY = "mongomodel:index";
const LEGACY_KEY = "mongomodel";
const dataKey = (id: string) => `mongomodel:d:${id}`;
// viewport (zoom/pan) ล่าสุดต่อ diagram — เปิดกลับมาอยู่ที่เดิม ไม่รีเซ็ตเป็น fit view เสมอ
const vpKey = (id: string) => `mongomodel:vp:${id}`;
const loadVp = (id: string): { x: number; y: number; zoom: number } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(vpKey(id)) ?? "null");
    return v && typeof v.x === "number" && typeof v.y === "number" && typeof v.zoom === "number" ? v : null;
  } catch {
    return null;
  }
};
// flag ครั้งแรกที่ sync ขึ้น server แล้ว — กัน migrate ซ้ำ (server ว่างหลังเคย sync = ว่างจริง)
const SYNCED_KEY = "mongomodel:server-synced";

// ลำดับสถานะความสัมพันธ์ตอน double-click เส้น
const REL_CYCLE: EdgeRelData[] = [
  { kind: "reference", cardinality: "1-1" },
  { kind: "reference", cardinality: "1-n" },
  { kind: "reference", cardinality: "n-n" },
  { kind: "embed", cardinality: "1-1" },
  { kind: "embed", cardinality: "1-n" },
  { kind: "embed", cardinality: "n-n" },
];

const CARD_LABEL: Record<string, string> = { "1-1": "1:1", "1-n": "1:N", "n-n": "N:N" };

// field มีลูกได้เฉพาะ Object หรือ Array ของ Object (ตรงกติกา codegen ใน schema.ts)
const canNest = (f: Field) =>
  f.type === "Object" || (f.type === "Array" && f.of === "Object");

// ---------- helper แก้ field ในต้นไม้ (nested) ตาม id ----------

const updateFieldInTree = (fields: Field[], fid: string, patch: Partial<Field>): Field[] =>
  fields.map((f) =>
    f.id === fid
      ? { ...f, ...patch }
      : f.children
        ? { ...f, children: updateFieldInTree(f.children, fid, patch) }
        : f
  );

const removeFieldInTree = (fields: Field[], fid: string): Field[] =>
  fields
    .filter((f) => f.id !== fid)
    .map((f) => (f.children ? { ...f, children: removeFieldInTree(f.children, fid) } : f));

// รวม field id ทุกชั้น (handle ของเส้นผูกกับ field id — ใช้เช็คว่าปลายเส้นยังมี field จริง)
const collectFieldIds = (fields: Field[], into: Set<string>): Set<string> => {
  for (const f of fields) {
    into.add(f.id);
    if (f.children) collectFieldIds(f.children, into);
  }
  return into;
};

// กวาดเส้นค้างใน "แท็บอื่น" หลังลบ node/field (เส้นข้าม tab เก็บใน diagram ต้นทาง = แท็บอื่น
// ถือเส้นชี้มาหาของที่เพิ่งถูกลบได้ → ค้างถาวรถ้าไม่กวาด) — คู่ขนาน dropEdgesTouching ฝั่ง MCP (server.ts)
// เช็คแบบ declarative กับ universe ทุกแท็บ: node หาย หรือ field ตาม handle หาย = เส้นตาย
// mutate เฉพาะ entry ของแท็บที่มีเส้นค้าง · คืนจำนวน + แท็บที่โดน เพื่อรายงานผู้ใช้ (ห้ามลบเงียบ)
const sweepCrossTabEdges = (
  diagrams: Record<string, { nodes: CollectionNode[]; edges: RelEdge[] }>,
  cur: string
): { removed: number; tabIds: string[] } => {
  const fieldsByNode = new Map<string, Set<string>>();
  for (const d of Object.values(diagrams))
    for (const n of d.nodes) fieldsByNode.set(n.id, collectFieldIds(n.data.fields, new Set()));
  // handle canonical = `${fieldId}-s/-t` (เก่าบางเส้นมี suffix ข้าง -l/-r) — ตัดให้เหลือ field id
  const fidOf = (h?: string | null) => h?.replace(/-[st](-[lr])?$/, "");
  const alive = (nodeId: string, handle?: string | null): boolean => {
    const fs = fieldsByNode.get(nodeId);
    if (!fs) return false; // node ปลายเส้นหายจากทุกแท็บ
    const f = fidOf(handle);
    return !f || fs.has(f); // field ปลายเส้นหายจาก node = เส้นตาย
  };
  let removed = 0;
  const tabIds: string[] = [];
  for (const [id, d] of Object.entries(diagrams)) {
    if (id === cur) continue; // แท็บปัจจุบันจัดการผ่าน deleteElements อยู่แล้ว (edges เป็น controlled state)
    const kept = d.edges.filter(
      (e) => alive(e.source, e.sourceHandle) && alive(e.target, e.targetHandle)
    );
    if (kept.length !== d.edges.length) {
      removed += d.edges.length - kept.length;
      diagrams[id] = { ...d, edges: kept };
      tabIds.push(id);
    }
  }
  return { removed, tabIds };
};

// กลุ่ม key ที่ pin บนสุดของ collection: PK(_id ตัวแรก) / key(🔑) / keygroup(⛓ key ผสม) — field อื่นตามหลัง
const isKeyField = (fields: Field[], f: Field): boolean =>
  Boolean(f.key || f.keygroup || (f.name === "_id" && fields.find((o) => o.name === "_id") === f));

/** field ที่เพิ่งติดธง key ให้กระโดดขึ้นไปต่อท้ายกลุ่ม key ด้านบน (คงลำดับเดิมภายในกลุ่ม) */
const pinKeyField = (fields: Field[], fid: string): Field[] => {
  const idx = fields.findIndex((f) => f.id === fid);
  if (idx < 0 || !isKeyField(fields, fields[idx])) return fields;
  const f = fields[idx];
  const rest = fields.filter((o) => o.id !== fid);
  let last = -1;
  rest.forEach((o, i) => {
    if (isKeyField(rest, o)) last = i;
  });
  rest.splice(last + 1, 0, f);
  return rest;
};

const addChildInTree = (fields: Field[], parentId: string, child: Field): Field[] =>
  fields.map((f) =>
    f.id === parentId
      ? { ...f, children: [...(f.children ?? []), child], collapsed: false }
      : f.children
        ? { ...f, children: addChildInTree(f.children, parentId, child) }
        : f
  );

// regenerate id ลึกทุกชั้น — clone แล้ว id ห้ามชนต้นฉบับ (handle/edit ผูกกับ id)
const cloneFields = (fs: Field[], ids = new Map<string, string>()): Field[] =>
  fs.map((f) => {
    const id = uid();
    ids.set(f.id, id);
    return {
      ...f,
      id,
      children: f.children ? cloneFields(f.children, ids) : undefined,
    };
  });

// clone คอลเลกชัน — regenerate field id ทุกตัว กัน handle ชนกับต้นฉบับ
// all = การ์ดที่มีอยู่ในแท็บ (ถ้าส่งมา): ใช้หาช่องว่างและตั้งชื่อไม่ซ้ำ — สูตรตำแหน่งคงที่เดิมทำให้
// ทำซ้ำจากการ์ดเดิม 2 ครั้ง = สำเนาลงพิกัดเดียวกันเป๊ะ ซ้อนทับจนกดใบล่างไม่ได้ + ชื่อ `_copy` ซ้ำกัน
// ทั้งที่แอปห้ามชื่อซ้ำ (rename/add_collection บล็อกอยู่แล้ว)
const cloneCollection = (n: CollectionNode, all: CollectionNode[] = []): CollectionNode => {
  const taken = new Set(all.filter((o) => o.id !== n.id).map((o) => o.data.label));
  let label = `${n.data.label}_copy`;
  for (let i = 2; taken.has(label); i++) label = `${n.data.label}_copy${i}`;
  const w = n.measured?.width ?? n.width ?? 432;
  const y = n.position.y;
  let x = n.position.x + w + 24;
  // เลื่อนขวาต่อไปเรื่อย ๆ จนไม่ทับการ์ดอื่นที่อยู่ระดับเดียวกัน
  for (let guard = 0; guard < 50; guard++) {
    const hit = all.some(
      (o) => Math.abs(o.position.y - y) < 60 && Math.abs(o.position.x - x) < 60
    );
    if (!hit) break;
    x += w + 24;
  }
  const fieldIds = new Map<string, string>();
  const fields = cloneFields(n.data.fields, fieldIds);
  const indexes = (n.data.indexes ?? []).flatMap((index) => {
    const parts = index.fields.map((part) => ({ ...part, field: fieldIds.get(part.field) }));
    return parts.every((part) => part.field)
      ? [{ ...index, id: uid(), fields: parts as CollectionIndex["fields"] }]
      : [];
  });
  return {
    id: uid(),
    type: "collection",
    position: { x, y },
    selected: false,
    data: { ...n.data, label, fields, ...(indexes.length ? { indexes } : { indexes: undefined }) },
  };
};

// ---------- ตัวอย่างเริ่มต้น ----------

const starterNodes: CollectionNode[] = [
  {
    id: "users",
    type: "collection",
    position: { x: 80, y: 120 },
    data: {
      label: "users",
      fields: [
        { id: "u1", name: "_id", type: "ObjectId", required: true },
        { id: "u2", name: "name", type: "String", required: true },
        { id: "u3", name: "email", type: "String", required: true },
        { id: "u4", name: "created_at", type: "Date", required: false },
      ],
    },
  },
  {
    id: "orders",
    type: "collection",
    position: { x: 520, y: 200 },
    data: {
      label: "orders",
      fields: [
        { id: "o1", name: "_id", type: "ObjectId", required: true },
        { id: "o2", name: "user_id", type: "ObjectId", required: true },
        { id: "o3", name: "total", type: "Number", required: true },
        { id: "o4", name: "status", type: "String", required: false },
      ],
    },
  },
];

const starterEdges: RelEdge[] = [
  {
    id: "e1",
    source: "orders",
    sourceHandle: "o2-s",
    target: "users",
    targetHandle: "u1-t",
  },
];

// ---------- แถวฟิลด์ (recursive — รองรับ nested document) ----------
// depth 0 = top-level: มี handle เชื่อมเส้น, grip ลากจัดลำดับ, U, ◇ ครบ
// depth > 0 = nested: เหลือ ชื่อ/ชนิด/required/of/💬/ลบ + ลูกต่อได้ (โครงสร้างภายใน doc)

type FieldRowProps = {
  field: Field;
  depth: number;
  topIndex: number; // index ใน fields ระดับบน (ใช้เฉพาะ depth 0 สำหรับลากจัดลำดับ)
  siblings: Field[]; // พี่น้องระดับเดียวกัน — เช็คชื่อซ้ำ
  isPK: boolean;
  onPatch: (fid: string, patch: Partial<Field>) => void;
  onRemove: (fid: string) => void;
  onAddChild: (parentId: string) => void;
  onEditDesc: (f: Field) => void;
  onEditEnumDefault: (f: Field) => void;
  onEditKeyGroup: (f: Field) => void;
  onDuplicate?: (fid: string) => void; // ทำซ้ำ field — เฉพาะระดับบน
  onAddAfterLast?: () => void; // Enter ที่ฟิลด์สุดท้าย = สร้างฟิลด์ใหม่ต่อ (พิมพ์รวดเดียวไม่ต้องแตะเมาส์)
  dragIndexRef: { current: number | null };
};

function FieldRow({
  field: f,
  depth,
  topIndex,
  siblings,
  isPK,
  onPatch,
  onRemove,
  onAddChild,
  onEditDesc,
  onEditEnumDefault,
  onEditKeyGroup,
  onDuplicate,
  onAddAfterLast,
  dragIndexRef,
}: FieldRowProps) {
  const top = depth === 0;
  const nest = canNest(f);
  // field ที่เป็น key (PK/🔑/⛓ keygroup) ไม่วาดจุดเชื่อมที่แถวตัวเอง — ย้ายไปรวมที่แถบ key ด้านบนการ์ด (KeyBar ใน CollectionNodeView) handle id เหมือนเดิมเส้นไม่พัง
  const keyHandles = top && (isPK || f.key || Boolean(f.keygroup));
  const nameErr =
    f.name.trim() === ""
      ? "ชื่อว่าง"
      : siblings.some((o) => o.id !== f.id && o.name === f.name)
        ? "ชื่อซ้ำ"
        : BAD_NAME_CHARS.test(f.name)
          ? 'มีอักขระต้องห้าม (. $ ` " \\ แท็บ/ขึ้นบรรทัด) — โค้ดที่ generate จะพัง'
          : "";
  return (
    <>
      <div className="relative flex items-center gap-1">
        {/* relation เป็น field→field: ต้นเส้น -s ซ้าย (FK) ปลายเส้น -t ขวา (business key ที่ถูกอ้าง) — ไม่มี handle ระดับ node */}
        {/* แถวลูกไม่มี ⠿ จึงเริ่มซ้ายกว่าแถวแม่ทั้งที่ indent 14px — จองที่เท่ากันไว้ ความลึกถึงจะอ่านออก */}
        {!top && (
          <span className="invisible shrink-0 select-none" aria-hidden="true">
            ⠿
          </span>
        )}
        {/* จับ ⠿ ลากปล่อยเพื่อจัดลำดับ field — เฉพาะ top-level */}
        {top && (
          <span
            className="nodrag mm-ico select-none text-slate-400 opacity-70 hover:text-slate-200 hover:opacity-100 active:cursor-grabbing"
            style={{ cursor: "grab" }}
            title="ลากเพื่อจัดลำดับฟิลด์"
            draggable
            onDragStart={(e) => {
              dragIndexRef.current = topIndex;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(topIndex));
            }}
            onDragEnd={() => {
              dragIndexRef.current = null;
            }}
          >
            ⠿
          </span>
        )}
        {/* _id = primary key ของ MongoDB — first-wins ตรงกับ codegen (เฉพาะ top-level); f.key = business key ที่ collection อื่นอ้างอิง; f.keygroup = สมาชิก key ผสม (⛓)
            ปุ่ม * (required) แสดงควบคู่ไอคอน key เสมอ ยกเว้น PK (_id บังคับ required อยู่แล้ว) — สมาชิก key ผสมต้อง toggle required ได้ตามที่ 🩺 ตรวจแนะนำ */}
        <span className="flex min-w-8 shrink-0 items-center justify-center gap-0.5 text-xs">
          {(isPK || f.key) && (
            <span title={isPK ? "Primary key" : "Business key — collection อื่นอ้างอิง field นี้"}>🔑</span>
          )}
          {f.keygroup && <span title={`สมาชิก key ผสม (กลุ่ม "${f.keygroup}") — รวมกับ field อื่นในกลุ่มเป็น key เดียว`}>⛓</span>}
          {!isPK && (
            <button
              className={`nodrag mm-ico font-bold ${f.required ? "text-red-400" : "text-slate-400 hover:text-slate-200"}`}
              aria-pressed={Boolean(f.required)}
              title={f.required ? "จำเป็นต้องมี (คลิกเพื่อยกเลิก)" : "ไม่บังคับ (คลิกเพื่อบังคับ)"}
              onClick={() => onPatch(f.id, { required: !f.required })}
            >
              *
            </button>
          )}
        </span>
        {/* พับ/ขยายฟิลด์ย่อย — เฉพาะชนิดที่มีลูกได้
            absolute: ถ้าอยู่ในสายเลย์เอาต์ แถวที่ "มีลูกได้" จะดันชื่อฟิลด์ไปขวา 18px แถวเดียวกัน
            จึงไม่ตรงคอลัมน์กับแถวอื่น (มากกว่าระยะ indent ของชั้นลูกเสียอีก = อ่านความลึกไม่ออก) */}
        {nest && (
          <button
            className="nodrag absolute -left-2.5 z-10 w-3 text-center text-slate-400 hover:text-slate-200"
            title={f.collapsed ? "ขยายฟิลด์ย่อย" : "พับฟิลด์ย่อย"}
            aria-expanded={!f.collapsed}
            onClick={() => onPatch(f.id, { collapsed: !f.collapsed })}
          >
            {f.collapsed ? "▸" : "▾"}
          </button>
        )}
        <input
          data-fid={f.id}
          aria-label={`ชื่อฟิลด์ ${f.name}`}
          className={`nodrag min-w-[3.5rem] flex-1 rounded px-1 py-0.5 outline-none hover:bg-slate-700/60 focus:bg-slate-700 ${
            f.name === "_id" && top ? "font-semibold text-amber-200" : "text-slate-200"
          } ${nameErr ? "ring-1 ring-red-500" : ""}`}
          value={f.name}
          placeholder="ชื่อฟิลด์"
          // ชื่อยาวกว่าช่องเสมอเมื่อการ์ดแคบ — hover อ่านเต็มได้ ไม่ต้องคลิกเข้าไปดูทีละช่อง
          title={nameErr || f.name}
          onChange={(e) => onPatch(f.id, { name: e.target.value })}
          // จำค่าตอนเริ่มแก้ — Esc คืนค่าเดิม (ความเคยชินสากล เหมือนช่องชื่อ collection)
          onFocus={(e) => {
            e.currentTarget.dataset.orig = f.name;
          }}
          // trim ช่องว่าง/แท็บหัวท้ายอัตโนมัติ (paste จาก Excel มักติดมา) — แบบเดียวกับชื่อ collection
          onBlur={(e) => {
            const t = e.currentTarget.value.trim();
            if (t !== e.currentTarget.value) onPatch(f.id, { name: t });
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onPatch(f.id, { name: e.currentTarget.dataset.orig ?? f.name });
              e.currentTarget.blur();
            } else if (e.key === "Enter") {
              // Enter = ยืนยัน + กระโดดไปช่องชื่อฟิลด์แถวถัดไป (สไตล์ Excel/Sheets)
              // แถวสุดท้าย = สร้างฟิลด์ใหม่ต่อเลย (เดิม blur เฉย ๆ ต้องละมือไปคลิก ＋ ทุกครั้ง)
              e.stopPropagation();
              const idx = siblings.findIndex((s) => s.id === f.id);
              const next = siblings[idx + 1];
              e.currentTarget.blur();
              if (next)
                document.querySelector<HTMLInputElement>(`input[data-fid="${next.id}"]`)?.focus();
              else onAddAfterLast?.();
            }
          }}
        />
        <span className="w-5 shrink-0 text-center text-[10px] text-slate-500" title={f.type}>
          {TYPE_ICON[f.type] ?? "?"}
        </span>
        <select
          className="nodrag shrink-0 rounded bg-slate-700 px-1 py-0.5 text-[11px] text-slate-300 outline-none"
          aria-label={`ชนิดข้อมูลของฟิลด์ ${f.name}`}
          value={f.type}
          onChange={(e) => {
            const t = e.target.value as FieldType;
            // Array ตั้ง of ให้ตรง select; ออกจาก Array ล้าง of
            const newOf = t === "Array" ? (f.of ?? "String") : undefined;
            // ออกจากชนิดที่มีลูกได้ → ล้าง children/collapsed กัน orphan ค้างใน export JSON
            const nestable = t === "Object" || (t === "Array" && newOf === "Object");
            onPatch(f.id, {
              type: t,
              of: newOf,
              ...(nestable ? {} : { children: undefined, collapsed: undefined }),
            });
          }}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        {/* ชนิดสมาชิก Array — แถวเดียวกัน */}
        {f.type === "Array" && (
          <select
            className="nodrag shrink-0 rounded bg-slate-700/70 px-1 py-0.5 text-[10px] text-slate-300 outline-none"
            title="ชนิดสมาชิกของ Array"
            aria-label={`ชนิดสมาชิกของ Array ในฟิลด์ ${f.name}`}
            value={f.of ?? "String"}
            onChange={(e) => {
              const of = e.target.value as FieldType;
              // ออกจาก Object → ล้าง children/collapsed (กฎเดียวกับ select ชนิดหลัก)
              onPatch(f.id, {
                of,
                ...(of === "Object" ? {} : { children: undefined, collapsed: undefined }),
              });
            }}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        )}
        {/* actions รอง — ค้างตลอด ไม่ซ่อนตอน hover (กันจอกระตุกตอนเลื่อน)
            ทุกปุ่มใช้ .mm-ico: hitbox 20×20 (เดิม 6.6×16 = 19% ของเกณฑ์ WCAG), มี hover/active/cursor
            ธง toggle ใส่ aria-pressed + วงแหวนตอนเปิด — เดิมต่างกันแค่ opacity (สถานะด้วยสีล้วน)
            เอา tabIndex={-1} ออกทั้งชุด — คีย์บอร์ดล้วนเคยตั้ง required/key/unique/ลบฟิลด์ ไม่ได้เลย */}
        {top && (
          <button
            className={`nodrag mm-ico text-[10px] ${
              f.enum?.length || f.default != null
                ? "text-sky-300 ring-1 ring-sky-400/60"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title={
              f.enum?.length || f.default != null
                ? `enum / ค่าเริ่มต้น: ${f.enum?.join(" | ") ?? "—"}${f.default != null ? ` (default ${f.default})` : ""} — กดเพื่อแก้`
                : "ตั้ง enum / ค่าเริ่มต้น"
            }
            onClick={() => onEditEnumDefault(f)}
          >
            ◇
          </button>
        )}
        {top && (
          <button
            className={`nodrag mm-ico text-[10px] ${
              f.key ? "opacity-100 ring-1 ring-sky-400/60" : "opacity-60 hover:opacity-100"
            }`}
            aria-pressed={Boolean(f.key)}
            title={f.key ? "business key — collection อื่นอ้างอิง field นี้ (คลิกเพื่อยกเลิก)" : "ตั้งเป็น business key (🔑) — จะติ๊ก * บังคับกรอกให้อัตโนมัติ (ยกเลิกเองได้)"}
            // key ที่ปล่อยว่างได้ = หลายเอกสารไม่มีค่า key แล้วอ้างอิงหาไม่เจอ — ติ๊ก required ให้เลย (ผู้ใช้กด * ถอดเองได้)
            onClick={() => onPatch(f.id, { key: !f.key, ...(!f.key && !f.required ? { required: true } : {}) })}
          >
            🔑
          </button>
        )}
        {top && (
          <button
            className={`nodrag mm-ico text-[10px] ${
              f.keygroup ? "text-sky-300 opacity-100 ring-1 ring-sky-400/60" : "opacity-60 hover:opacity-100"
            }`}
            title={f.keygroup ? `key ผสม กลุ่ม "${f.keygroup}" (คลิกเพื่อแก้/ออกจากกลุ่ม)` : "ตั้ง key ผสม — หลาย field รวมเป็น key เดียว (⛓)"}
            onClick={() => onEditKeyGroup(f)}
          >
            ⛓
          </button>
        )}
        {top && (
          <button
            className={`nodrag mm-ico text-[10px] font-bold ${
              f.unique ? "text-amber-300 ring-1 ring-amber-400/60" : "text-slate-400 hover:text-slate-200"
            }`}
            aria-pressed={Boolean(f.unique)}
            title={f.unique ? "unique index (คลิกเพื่อยกเลิก)" : "ตั้งเป็น unique index"}
            onClick={() => onPatch(f.id, { unique: !f.unique })}
          >
            U
          </button>
        )}
        {/* array ของ object เท่านั้น — ยืนยันว่ามีขอบเขต (ไม่โตไม่จำกัดจนชนเพดานเอกสาร 16MB) */}
        {f.type === "Array" && (f.of === "Object" || (f.children?.length ?? 0) > 0) && (
          <button
            className={`nodrag mm-ico text-[10px] ${
              f.bounded ? "text-emerald-300 ring-1 ring-emerald-400/60" : "text-slate-400 hover:text-slate-200"
            }`}
            aria-pressed={Boolean(f.bounded)}
            title={
              f.bounded
                ? "ยืนยันแล้วว่า array นี้มีขอบเขต (linter ไม่เตือนเรื่องเพดาน 16MB)"
                : "ทำเครื่องหมายว่า array นี้มีขอบเขตแล้ว — ไม่โตไม่จำกัด"
            }
            onClick={() => onPatch(f.id, { bounded: !f.bounded })}
          >
            ⊂
          </button>
        )}
        <button
          className={`nodrag mm-ico text-[10px] ${
            f.description && isThaiText(f.description)
              ? "opacity-90"
              : "text-amber-400 opacity-90 hover:opacity-100"
          }`}
          title={
            f.description && isThaiText(f.description)
              ? "แก้คำอธิบายฟิลด์"
              : "ยังไม่มีคำอธิบายภาษาไทย — กดเพื่อเพิ่ม (บังคับ)"
          }
          onClick={() => onEditDesc(f)}
        >
          💬
        </button>
        {top && onDuplicate && (
          <button
            className="nodrag mm-ico text-[10px] text-slate-400 hover:text-sky-300"
            title="ทำซ้ำฟิลด์นี้ (คัดลอกชื่อ/ชนิด/ตัวเลือกทั้งหมด)"
            onClick={() => onDuplicate(f.id)}
          >
            ⧉
          </button>
        )}
        {/* ปุ่มทำลายข้อมูล — เว้นระยะจากกลุ่มไอคอนอื่น กันกดพลาดจาก ⧉ ที่อยู่ติดกัน 5px */}
        <button
          className="nodrag mm-ico ml-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
          title="ลบฟิลด์"
          onClick={() => onRemove(f.id)}
        >
          ✕
        </button>
        {/* จุดเชื่อมลอยนอกการ์ด แยกตำแหน่งกัน: -s (FK ต้นเส้น) นอก 10px, -t (amber ปลายทาง) นอก 24px — ไม่ทับไอคอนในแถว ไม่ทับกันเอง หัวลูกศรอยู่นอกการ์ดเห็นชัด
            ข้างที่ใช้เลือกอัตโนมัติตอน render (displayEdges); เก็บ canonical -s/-t (normalize ตอน onConnect); ลากเริ่มได้ทั้ง 2 ฝั่ง React Flow จัดทิศตาม type เอง
            key field (PK/🔑/⛓) ข้ามตรงนี้ — จุดเชื่อมอยู่ที่แถบ key ด้านบนการ์ดแทน */}
        {top && !keyHandles && (
          <>
            <Handle type="target" position={Position.Left} id={`${f.id}-t-l`} className="!bg-amber-400" style={{ left: -24 }} />
            <Handle type="target" position={Position.Right} id={`${f.id}-t-r`} className="!bg-amber-400" style={{ right: -24 }} />
            <Handle type="source" position={Position.Left} id={`${f.id}-s-l`} style={{ left: -10 }} />
            <Handle type="source" position={Position.Right} id={`${f.id}-s-r`} style={{ right: -10 }} />
          </>
        )}
      </div>
      {/* คำอธิบาย — บรรทัดของตัวเอง เต็มข้อความ ขึ้นบรรทัดใหม่อัตโนมัติ (ไม่ตัด …) คลิกเพื่อแก้ */}
      {f.description && (
        <div
          className="nodrag mt-0.5 cursor-text whitespace-pre-wrap break-words pl-[38px] pr-1 text-[10px] leading-[1.6] text-slate-400/90"
          title="คลิกเพื่อแก้คำอธิบาย"
          onClick={() => onEditDesc(f)}
        >
          {f.description}
        </div>
      )}
      {/* enum / default — แสดง inline ถ้าตั้งไว้ (ตั้งได้เฉพาะ top-level) */}
      {top && ((f.enum?.length ?? 0) > 0 || f.default != null) && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 pl-[22px] pr-1 text-[10px] leading-[1.6] text-slate-400/90 break-words">
          {(f.enum?.length ?? 0) > 0 && <span>◇ {f.enum!.join(" | ")}</span>}
          {f.default != null &&
            (f.type === "Boolean" && !/^(true|false)$/i.test(f.default.trim()) ? (
              <span className="text-red-400" title='Boolean ต้องเป็น "true" หรือ "false" — ค่าอื่นจะกลายเป็น false'>
                = {f.default}
              </span>
            ) : (
              <span>= {f.default}</span>
            ))}
        </div>
      )}
      {/* ฟิลด์ย่อย recursive — indent ชั้นละ 14px, เกิน depth 6 หยุด indent ให้อ่านไหว */}
      {nest && !f.collapsed && (
        <div className={depth < 6 ? "ml-1 border-l border-white/10 pl-3.5" : ""}>
          {(f.children ?? []).map((c) => (
            <FieldRow
              key={c.id}
              field={c}
              depth={depth + 1}
              topIndex={-1}
              siblings={f.children ?? []}
              isPK={false}
              onPatch={onPatch}
              onRemove={onRemove}
              onAddChild={onAddChild}
              onEditDesc={onEditDesc}
              onEditEnumDefault={onEditEnumDefault}
              onEditKeyGroup={onEditKeyGroup}
              onAddAfterLast={() => onAddChild(f.id)}
              dragIndexRef={dragIndexRef}
            />
          ))}
          <button
            className="nodrag block py-0.5 pl-[22px] text-left text-[10px] text-sky-400 hover:text-sky-300"
            onClick={() => onAddChild(f.id)}
          >
            ＋ ฟิลด์ย่อย
          </button>
        </div>
      )}
    </>
  );
}

// ---------- โหนดคอลเลกชัน ----------

function CollectionNodeView({ id, data, selected }: NodeProps<CollectionNode>) {
  const { updateNodeData, deleteElements, getEdges, getNode, getNodes, addNodes } =
    useReactFlow<CollectionNode>();
  const updateNodeInternals = useUpdateNodeInternals();
  const [editingLabel, setEditingLabel] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [editError, setEditError] = useState(""); // error validate คำอธิบายไทยใน popup (ว่าง/ไม่ใช่ไทย)
  const dragIndex = useRef<number | null>(null); // index ของ field ที่กำลังลาก
  const [dropAt, setDropAt] = useState<number | null>(null); // แถวเป้าหมายระหว่างลาก — วาดเส้นบอกตำแหน่ง
  // ซูมต้องเปลี่ยนเฉพาะขนาดภาพ ห้ามซ่อน field/description/index แล้วทำให้ผู้ใช้คิดว่าข้อมูลหาย
  const compact = false;
  const connectedFieldIds = useStore(
    (s) => {
      const found = new Set<string>();
      for (const edge of s.edges) {
        if (edge.source === id && edge.sourceHandle) {
          found.add(edge.sourceHandle.replace(/-s(-[lr])?$/, ""));
        }
        if (edge.target === id && edge.targetHandle) {
          found.add(edge.targetHandle.replace(/-t(-[lr])?$/, ""));
        }
      }
      return [...found].sort();
    },
    (a, b) => a.length === b.length && a.every((value, i) => value === b[i]),
  );
  const connectedSignature = connectedFieldIds.join("|");
  useEffect(() => updateNodeInternals(id), [compact, connectedSignature, id, updateNodeInternals]);

  // ชื่อคอลเลกชันทุก node — ไว้เช็คชื่อซ้ำ (equality กันร re-render ทุกครั้งที่ store ขยับ)
  const labels = useStore(
    (s) => s.nodes.map((n) => (n.data as CollectionData).label),
    (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
  );
  const labelErr =
    data.label.trim() === ""
      ? "ชื่อว่าง"
      : labels.filter((l) => l === data.label).length > 1
        ? "ชื่อซ้ำ"
        : "";

  // key ทั้งหมดของ collection (PK ตัวแรก/🔑/⛓ keygroup) — แสดงสรุปที่แถบ key ด้านบนการ์ด พร้อมจุดเชื่อมเส้น (ย้ายมาจากแถว field)
  const keyFields = data.fields.filter((f) => isKeyField(data.fields, f));
  // กลุ่ม key ผสม — fields ที่มี keygroup เดียวกันรวมแสดงเป็นกลุ่มเดียว (⛓ a + b + c) สมาชิกแต่ละตัวยังมีจุดเชื่อมสำหรับเก็บ mapping ราย field
  const keyGroups = keyGroupsOf(data.fields);
  const groupMemberIds = new Set(keyGroups.flatMap((g) => g.fields.map((f) => f.id)));
  const soloKeys = keyFields.filter((f) => !groupMemberIds.has(f.id));
  const fieldEntries = fieldPathEntries(data.fields);
  const fieldPathById = new Map(fieldEntries.map(({ path, field }) => [field.id, path]));
  const connectedSet = new Set(connectedFieldIds);
  const visibleFields = compact
    ? data.fields.filter((field) => !isKeyField(data.fields, field) && connectedSet.has(field.id))
    : data.fields;
  const indexText = (index: CollectionIndex): string =>
    index.fields
      .map((part) => `${fieldPathById.get(part.field) ?? `[ไม่พบ:${part.field}]`}:${part.direction}`)
      .join(", ");

  // collection ในแท็บนี้ที่อ้างถึง key แต่ละตัว (เส้นขาเข้า) — แสดง badge ← N ที่แถบ key
  const refFrom = useStore(
    (s) => {
      const m: Record<string, string[]> = {};
      for (const e of s.edges) {
        if (e.target !== id || !e.targetHandle) continue;
        const fid = e.targetHandle.replace(/-t(-[lr])?$/, "");
        const lbl = (s.nodes.find((n) => n.id === e.source)?.data as CollectionData | undefined)
          ?.label;
        if (lbl && !(m[fid] ??= []).includes(lbl)) m[fid].push(lbl);
      }
      return m;
    },
    (a, b) => {
      const ka = Object.keys(a);
      return (
        ka.length === Object.keys(b).length &&
        ka.every((k) => {
          const x = a[k];
          const y = b[k];
          return !!y && x.length === y.length && x.every((v, i) => v === y[i]);
        })
      );
    }
  );

  // แถว key 1 แถวในแถบ key (ใช้ทั้ง key เดี่ยวและสมาชิก key ผสม) — จุดเชื่อมครบ 4 handle (id เดิมจากแถว field เส้นไม่พัง) + badge จำนวนที่ถูกอ้าง
  // reorder: ใส่เฉพาะสมาชิก key ผสม — ปุ่ม ↑↓ เรียงลำดับในกลุ่ม (ลำดับมีผลต่อ compound index)
  const keyRow = (f: Field, reorder?: { first: boolean; last: boolean; onUp: () => void; onDown: () => void; onRemove: () => void; unique: boolean }) => {
    const pk = f.name === "_id" && data.fields.find((o) => o.name === "_id") === f;
    const refs = refFrom[f.id] ?? [];
    return (
      <div key={f.id} className="relative flex items-center gap-1 py-0.5">
        {/* spacer ความกว้างเท่า grip ⠿ ของแถว field — ให้คอลัมน์ไอคอน/ชื่อของ key ตรงระดับซ้ายกับแถว field (key กับ field คนละเรื่องกัน แต่ต้องเรียงระดับเดียวกัน) */}
        <span className="invisible shrink-0 select-none" aria-hidden="true">⠿</span>
        <span className="flex min-w-8 shrink-0 items-center justify-center gap-0.5 text-xs">
          {(pk || f.key) && (
            <span title={pk ? "Primary key" : "Business key — collection อื่นอ้างอิง field นี้"}>🔑</span>
          )}
          {f.keygroup && <span title={`สมาชิก key ผสม (กลุ่ม "${f.keygroup}")`}>⛓</span>}
        </span>
        <span className={`font-semibold ${pk ? "text-amber-200" : "text-slate-100"}`}>
          {f.name}
        </span>
        {reorder?.unique && !f.required && (
          <span
            className="text-[10px] text-amber-400"
            title="สมาชิก key ผสมแบบห้ามซ้ำควรบังคับ required — ถ้าว่างได้ เอกสารที่ว่างตรงกัน ≥2 แถวจะชน unique (duplicate null) บันทึกไม่ผ่าน"
          >
            ⚠
          </span>
        )}
        <span className="text-[10px] text-slate-400" title={f.type}>
          {TYPE_ICON[f.type] ?? "?"}
        </span>
        {reorder && (
          <span className="nodrag ml-auto flex shrink-0 items-center gap-0.5">
            {/* text-slate-500 บนพื้นแถบ key สีน้ำเงินได้แค่ 1.6:1 — ใช้ slate-300 (ผ่านทั้งสองธีม) */}
            <button
              className="mm-ico text-[10px] text-slate-300 hover:text-sky-300 disabled:opacity-20 disabled:hover:text-slate-300"
              title="เลื่อนขึ้น — ลำดับใน key ผสมมีผลต่อ compound index (prefix)"
              disabled={reorder.first}
              onClick={reorder.onUp}
            >
              ↑
            </button>
            <button
              className="mm-ico text-[10px] text-slate-300 hover:text-sky-300 disabled:opacity-20 disabled:hover:text-slate-300"
              title="เลื่อนลง — ลำดับใน key ผสมมีผลต่อ compound index (prefix)"
              disabled={reorder.last}
              onClick={reorder.onDown}
            >
              ↓
            </button>
            <button
              className="mm-ico text-[10px] text-slate-300 hover:bg-red-500/15 hover:text-red-400"
              title="เอาออกจาก key ผสม (field ยังอยู่)"
              onClick={reorder.onRemove}
            >
              ✕
            </button>
          </span>
        )}
        {refs.length > 0 && (
          <span
            className="ml-auto rounded px-1.5 text-[10px] font-medium text-amber-300"
            title={`ถูกอ้างโดย (แท็บนี้): ${refs.join(", ")}`}
          >
            ← {refs.length}
          </span>
        )}
        {/* จุดเชื่อมของ key — handle id เดิมที่เคยอยู่แถว field เส้นเดิมไม่พัง; ข้างซ้าย/ขวาเลือกอัตโนมัติตอน render (displayEdges) */}
        <Handle type="target" position={Position.Left} id={`${f.id}-t-l`} className="!bg-amber-400" style={{ left: -24 }} />
        <Handle type="target" position={Position.Right} id={`${f.id}-t-r`} className="!bg-amber-400" style={{ right: -24 }} />
        <Handle type="source" position={Position.Left} id={`${f.id}-s-l`} style={{ left: -10 }} />
        <Handle type="source" position={Position.Right} id={`${f.id}-s-r`} style={{ right: -10 }} />
      </div>
    );
  };

  // เอาสมาชิกออกจาก key ผสม (field ยังอยู่ — แค่ล้าง keygroup; ถ้ายังมี key จะไปอยู่แถว key เดี่ยวแทน)
  const removeFromGroup = (f: Field) => patchField(f.id, { keygroup: undefined });

  // ยกเลิก key ผสมทั้งกลุ่ม — ล้าง keygroup ทุกสมาชิก (fields ไม่ถูกลบ)
  const removeGroup = (g: { id: string; fields: Field[] }) => {
    let fs = data.fields;
    for (const f of g.fields) fs = updateFieldInTree(fs, f.id, { keygroup: undefined });
    updateNodeData(id, { fields: fs });
  };

  // สลับโหมดกลุ่ม ห้ามซ้ำ ⇄ ซ้ำได้ — เขียน keygroupunique ซ้ำทุกสมาชิก (ค่ากลุ่มอ่านจากตัวแรก)
  const setGroupUnique = (g: { id: string; fields: Field[] }, unique: boolean) => {
    let fs = data.fields;
    for (const f of g.fields) fs = updateFieldInTree(fs, f.id, { keygroupunique: unique });
    updateNodeData(id, { fields: fs });
  };

  // เรียงลำดับสมาชิก key ผสม — ลำดับกลุ่มผูกกับลำดับ field จริง (source of truth เดียว: codegen compound index ออกตามลำดับนี้)
  // สลับเฉพาะสมาชิกในกลุ่ม โดยยัดสมาชิกกลับช่องเดิมของตัวเองตามลำดับใหม่ (field อื่นไม่ขยับ)
  const moveGroupMember = (g: { id: string; fields: Field[] }, fid: string, dir: -1 | 1) => {
    const ids = g.fields.map((f) => f.id);
    const i = ids.indexOf(fid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    const slots = data.fields
      .map((f, idx) => (ids.includes(f.id) ? idx : -1))
      .filter((x) => x >= 0)
      .sort((a, b) => a - b);
    const byId = new Map(data.fields.map((f) => [f.id, f]));
    const fs = [...data.fields];
    slots.forEach((slot, k) => {
      fs[slot] = byId.get(next[k])!;
    });
    updateNodeData(id, { fields: fs });
  };

  const removeEdgesTouching = (deadIds: Set<string>) => {
    const dead = getEdges().filter(
      (edge) =>
        (edge.source === id && deadIds.has(edge.sourceHandle?.replace(/-s(-[lr])?$/, "") ?? "")) ||
        (edge.target === id && deadIds.has(edge.targetHandle?.replace(/-t(-[lr])?$/, "") ?? "")),
    );
    if (dead.length) deleteElements({ edges: dead.map((edge) => ({ id: edge.id })) });
  };

  const patchField = (fid: string, patch: Partial<Field>) => {
    const previous = fieldEntries.find(({ field }) => field.id === fid)?.field;
    const replacesChildren = Object.prototype.hasOwnProperty.call(patch, "children");
    const deadIds = replacesChildren && previous
      ? collectFieldIds(previous.children ?? [], new Set<string>())
      : new Set<string>();
    const patched = updateFieldInTree(data.fields, fid, patch);
    const indexes = deadIds.size
      ? (data.indexes ?? []).filter((index) => !index.fields.some((part) => deadIds.has(part.field)))
      : data.indexes;
    // ติดธง key/keygroup ปุ๊บ pin ขึ้นกลุ่ม key ด้านบนทันที (เฉพาะระดับบน)
    updateNodeData(id, {
      fields:
        patch.key === true || (typeof patch.keygroup === "string" && patch.keygroup !== "")
          ? pinKeyField(patched, fid)
          : patched,
      ...(deadIds.size && { indexes: indexes?.length ? indexes : undefined }),
    });
    if (deadIds.size) removeEdgesTouching(deadIds);
  };

  const removeField = (fid: string) => {
    const removed = fieldEntries.find(({ field }) => field.id === fid)?.field;
    const deadIds = removed ? collectFieldIds([removed], new Set<string>()) : new Set([fid]);
    const indexes = (data.indexes ?? []).filter(
      (index) => !index.fields.some((part) => deadIds.has(part.field)),
    );
    updateNodeData(id, {
      fields: removeFieldInTree(data.fields, fid),
      indexes: indexes.length ? indexes : undefined,
    });
    // ต้องผ่าน deleteElements เพราะ edges เป็น controlled state และ onEdgesChange เก็บ history
    removeEdgesTouching(deadIds);
  };

  // โฟกัสช่องชื่อของ field ที่เพิ่งสร้าง (query DOM หลัง render — click เป็น discrete event React flush ให้ก่อน timeout)
  const focusFieldName = (fid: string) =>
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`input[data-fid="${fid}"]`);
      el?.focus();
      el?.select();
    }, 0);

  const addField = () => {
    // โฟกัสช่องชื่อทันทีให้ตั้งชื่อก่อน (คำอธิบายไทยค่อยเติมผ่าน 💬 — marker เหลืองเตือนจนกว่าจะใส่)
    // ห้ามเปิด popup คำอธิบายเองตรงนี้: popup ที่เด้งเองกลืนคลิกถัดไปของผู้ใช้ และได้คำอธิบายผูกกับชื่อ auto (field_2)
    const nf: Field = {
      id: uid(),
      name: "field_" + (data.fields.length + 1),
      type: "String" as FieldType,
      required: false,
    };
    updateNodeData(id, { fields: [...data.fields, nf] });
    focusFieldName(nf.id);
  };

  const addChild = (parentId: string) => {
    const nf: Field = { id: uid(), name: "field", type: "String" as FieldType, required: false };
    updateNodeData(id, { fields: addChildInTree(data.fields, parentId, nf) });
    focusFieldName(nf.id);
  };

  // ทำซ้ำ field (เฉพาะระดับบน) — pattern ซ้ำๆ อย่าง created_at/updated_at ไม่ต้องพิมพ์ใหม่ทุกครั้ง
  const duplicateField = (fid: string) => {
    const idx = data.fields.findIndex((f) => f.id === fid);
    if (idx < 0) return;
    const src = data.fields[idx];
    const copy: Field = {
      ...src,
      id: uid(),
      name: `${src.name}_copy`,
      children: src.children ? cloneFields(src.children) : undefined,
    };
    const fs = [...data.fields];
    fs.splice(idx + 1, 0, copy);
    updateNodeData(id, { fields: fs });
    focusFieldName(copy.id); // ให้แก้ชื่อได้ทันที
  };

  const duplicate = () => {
    const n = getNode(id);
    if (n) addNodes(cloneCollection(n, getNodes()));
  };

  // จัดลำดับ field ด้วยการลากปล่อย (edge ไม่พังเพราะ handle ผูก field id)
  const reorderField = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const fs = [...data.fields];
    const [moved] = fs.splice(from, 1);
    fs.splice(to, 0, moved);
    updateNodeData(id, { fields: fs });
  };

  // เปิด popup ป้อนรายละเอียด (แทน window.prompt) — ล้าง error เก่าทุกครั้งที่เปิด
  const editDescription = () => {
    setEditError("");
    setEditing({ kind: "collDesc", text: data.description ?? "", orig: data.description ?? "" });
  };
  const editFieldDescription = (f: Field) => {
    setEditError("");
    setEditing({ kind: "fieldDesc", fid: f.id, name: f.name, text: f.description ?? "", orig: f.description ?? "" });
  };

  // ปิด popup จากพื้นหลัง/Esc — ถ้าพิมพ์คำอธิบายค้างไว้ (ต่างจากค่าเดิม) ต้องถามก่อนทิ้ง
  const closeEditing = () => {
    if (
      editing &&
      (editing.kind === "collDesc" || editing.kind === "fieldDesc") &&
      editing.text !== editing.orig
    ) {
      setConfirmDiscard(true);
      return;
    }
    setEditing(null);
  };
  const editEnumDefault = (f: Field) =>
    setEditing({
      kind: "enumDefault",
      fid: f.id,
      name: f.name,
      enumText: f.enum?.join(", ") ?? "",
      def: f.default ?? "",
    });
  const editKeyGroup = (f: Field) =>
    setEditing({ kind: "keyGroup", fid: f.id, name: f.name, text: f.keygroup ?? "" });
  const editIndex = (index?: CollectionIndex) => {
    setEditError("");
    setEditing({
      kind: "index",
      ...(index && { iid: index.id }),
      text: index
        ? index.fields
            .map((part) => `${fieldPathById.get(part.field) ?? part.field}:${part.direction}`)
            .join("\n")
        : "",
      unique: index?.unique ?? false,
      sparse: index?.sparse ?? false,
    });
  };
  const removeIndex = (iid: string) => {
    const indexes = (data.indexes ?? []).filter((index) => index.id !== iid);
    updateNodeData(id, { indexes: indexes.length ? indexes : undefined });
  };

  // บันทึกค่าจาก popup — คำอธิบายบังคับภาษาไทย (ว่าง/ไม่ใช่ไทย = ไม่ให้บันทึก)
  const saveEditing = () => {
    if (!editing) return;
    if (editing.kind === "collDesc" || editing.kind === "fieldDesc") {
      const text = editing.text.trim();
      if (!text) {
        setEditError("ต้องมีคำอธิบายภาษาไทยเสมอ");
        return;
      }
      if (!isThaiText(text)) {
        setEditError("คำอธิบายต้องมีอักขระภาษาไทยอย่างน้อย 1 ตัว");
        return;
      }
      if (editing.kind === "collDesc") updateNodeData(id, { description: text });
      else patchField(editing.fid, { description: text });
    } else if (editing.kind === "keyGroup") {
      // key ผสม — ว่าง = ออกจากกลุ่ม (id กลุ่มเป็น identifier ไม่บังคับไทย)
      patchField(editing.fid, { keygroup: editing.text.trim() || undefined });
    } else if (editing.kind === "index") {
      const byPath = new Map(fieldEntries.map(({ path, field }) => [path, field]));
      const members = new Set<string>();
      const parts: CollectionIndex["fields"] = [];
      const parseMember = (raw: string) => {
        const match = raw.match(/^(.*?):\s*(1|-1)$/);
        const ref = (match?.[1] ?? raw).trim();
        const field = byPath.get(ref) ?? fieldEntries.find((entry) => entry.field.id === ref)?.field;
        return { match, ref, field };
      };
      const inputRows = indexInputRows(editing.text, (line) => Boolean(parseMember(line).field));
      for (const raw of inputRows) {
        const { match, ref, field } = parseMember(raw);
        if (!field) {
          setEditError(`ไม่พบฟิลด์ "${ref}" — ใช้ชื่อแบบ dotted path เช่น address.city`);
          return;
        }
        if (members.has(field.id)) {
          setEditError(`ฟิลด์ "${ref}" ซ้ำใน index เดียวกัน`);
          return;
        }
        members.add(field.id);
        parts.push({ field: field.id, direction: match?.[2] === "-1" ? -1 : 1 });
      }
      if (!parts.length) {
        setEditError("ต้องมีอย่างน้อย 1 ฟิลด์");
        return;
      }
      if (parts.length > 32) {
        setEditError("compound index มีได้ไม่เกิน 32 ฟิลด์ตามเพดาน MongoDB");
        return;
      }
      if (!editing.iid && (data.indexes?.length ?? 0) >= 63) {
        setEditError("เพิ่มไม่ได้: MongoDB จำกัด index รวม _id และ index อัตโนมัติไม่เกิน 64 ชุด");
        return;
      }
      const signature = JSON.stringify(parts.map((part) => [part.field, part.direction]));
      const duplicate = (data.indexes ?? []).some(
        (index) =>
          index.id !== editing.iid &&
          JSON.stringify(index.fields.map((part) => [part.field, part.direction])) === signature,
      );
      if (duplicate) {
        setEditError("มี index ที่ใช้ฟิลด์และลำดับแบบนี้อยู่แล้ว");
        return;
      }
      const next: CollectionIndex = {
        id: editing.iid ?? uid(),
        fields: parts,
        ...(editing.unique && { unique: true }),
        ...(editing.sparse && { sparse: true }),
      };
      const indexes = editing.iid
        ? (data.indexes ?? []).map((index) => (index.id === editing.iid ? next : index))
        : [...(data.indexes ?? []), next];
      updateNodeData(id, { indexes });
    } else {
      const list = editing.enumText.split(",").map((s) => s.trim()).filter(Boolean);
      patchField(editing.fid, {
        enum: list.length ? list : undefined,
        default: editing.def.trim() || undefined,
      });
    }
    setEditing(null);
  };

  return (
    <div
      // min-w 27rem (เดิม 22rem): ที่ 22rem ช่องชื่อฟิลด์เหลือ ~17px = อ่านได้ 2 ตัวอักษร เพราะทุกอย่าง
      // อื่นในแถวเป็น shrink-0 · ต้องขยับคู่กับ minWidth ของ NodeResizeControl ข้างล่างเสมอ
      className={`mm-card w-full min-w-[27rem] border text-xs ${selected ? "mm-card-selected border-sky-400/70" : "border-white/10"}`}
    >
      {/* ลากขอบขวาปรับความกว้าง (สูง auto, width เก็บถาวรใน node)
          ไม่ใช้ prop color — มันตั้ง borderColor เป็น inline style ทำให้ CSS โชว์แถบตอน hover ไม่ได้
          (สไตล์ทั้งหมดอยู่ที่ .mm-resize ใน globals.css: hitbox กว้างขึ้น + แถบสีตอน hover การ์ด) */}
      {!compact && <NodeResizeControl
        variant={ResizeControlVariant.Line}
        position="right"
        minWidth={432}
        maxWidth={1000}
        className="mm-resize"
      />}

      {/* หัวคอลเลกชัน */}
      <div
        className={`mm-card-head relative flex items-center gap-2 border-b border-white/10 px-3 py-2 ${labelErr ? "ring-1 ring-red-500" : ""}`}
        title={labelErr || undefined}
      >
        {/* ไม่มี handle ระดับ node — relation ต้องชี้ลง field เป้าหมาย (business key) เสมอ */}
        {/* ชื่อเป็นข้อความ → กดค้างที่หัวเพื่อย้าย node ได้, ดับเบิลคลิกเพื่อแก้ inline */}
        {editingLabel ? (
          <input
            className="nodrag w-0 flex-1 rounded bg-blue-950 px-1 py-0.5 text-[15px] font-bold text-slate-100 outline-none ring-1 ring-sky-500"
            aria-label="ชื่อคอลเลกชัน"
            autoFocus
            defaultValue={data.label}
            onFocus={(e) => {
              // จำชื่อเดิมไว้ — Esc คืนค่า และใช้เทียบตอน blur ว่า rename ไปชนชื่อซ้ำไหม
              e.currentTarget.dataset.orig = data.label;
              e.currentTarget.select();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            // commit เข้า state ทันทีทุกตัวอักษร (ไม่รอ blur) — ปิดแท็บกลางคันข้อความไม่หาย
            // และ labelErr โชว์กรอบแดงสดเมื่อพิมพ์ชนชื่อซ้ำ
            onChange={(e) => updateNodeData(id, { label: e.currentTarget.value })}
            onBlur={(e) => {
              const orig = e.currentTarget.dataset.orig ?? data.label;
              const v = e.currentTarget.value.trim();
              // ห้าม rename ชนชื่อ collection อื่นในผังเดียวกัน — กฎเดียวกับตอนเพิ่มใหม่/add_collection ฝั่ง MCP
              // (ปล่อยผ่านแล้วผู้ใช้จะไปเจอสคริปต์พังเงียบๆ ตอนสร้างโค้ด)
              if (v !== orig && labels.filter((l) => l === v).length > 1) {
                updateNodeData(id, { label: orig });
                setEditingLabel(false);
                window.alert(`มีคอลเลกชันชื่อ "${v}" อยู่แล้วในแท็บนี้ — ใช้ชื่อซ้ำไม่ได้ (คืนชื่อเดิม "${orig}")`);
                return;
              }
              updateNodeData(id, { label: v });
              setEditingLabel(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation(); // กัน react flow / คีย์ลัด global จับ
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                const orig = e.currentTarget.dataset.orig ?? data.label;
                e.currentTarget.value = orig; // ยกเลิก = คืนค่าเดิมก่อน blur commit
                updateNodeData(id, { label: orig });
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span
            // 15px/700 — ชื่อ collection เคยใหญ่กว่าชื่อฟิลด์แค่ 1.17 เท่า แยกลำดับชั้นด้วยขนาดแทบไม่ได้
            className="flex-1 truncate text-[15px] font-bold text-slate-100"
            title="กดค้างเพื่อย้าย • ดับเบิลคลิกเพื่อแก้ชื่อ"
            onDoubleClick={() => setEditingLabel(true)}
          >
            {data.label || <span className="font-normal text-blue-300">ชื่อคอลเลกชัน</span>}
          </span>
        )}
        <button
          className={`nodrag mm-ico text-xs ${
            data.description && isThaiText(data.description)
              ? "opacity-100"
              : "text-amber-400 opacity-90 hover:opacity-100"
          }`}
          title={
            data.description && isThaiText(data.description)
              ? data.description
              : "ยังไม่มีคำอธิบายภาษาไทย — กดเพื่อเพิ่ม (บังคับ)"
          }
          onClick={editDescription}
        >
          💬
        </button>
        <button
          className="nodrag mm-ico text-blue-300 hover:text-sky-300"
          title="ทำซ้ำคอลเลกชัน (Ctrl+D)"
          onClick={duplicate}
        >
          ⧉
        </button>
        <button
          className="nodrag mm-ico text-blue-300 hover:text-red-400"
          title="ลบคอลเลกชัน"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ✕
        </button>
      </div>

      {/* คำอธิบายคอลเลกชัน — แสดง inline ถ้ามี */}
      {!compact && data.description && (
        // ไม่ใส่ italic — Noto Sans Thai ไม่มีฟอนต์เอียงจริง เบราว์เซอร์ skew เอง หัวอักษรไทยเพี้ยน (ถ/ภ ด/ค บ/ป)
        <div className="border-b border-slate-700/60 bg-slate-800/40 px-3 py-1 text-[11px] leading-[1.6] text-slate-400 whitespace-pre-wrap break-words">
          {data.description}
        </div>
      )}

      {/* แถบ key — สรุป key ทั้งหมดของ collection (PK/🔑/⛓ key ผสม) ไว้ด้านบนเสมอ พร้อมจุดเชื่อมเส้นข้างการ์ด (ลากเชื่อม collection อื่นมาที่ key ได้เลย) + badge จำนวนที่ถูกอ้าง */}
      {keyFields.length > 0 && (
        <div className="border-b border-slate-700/60 bg-blue-950/40 px-3 py-1">
          {/* ป้ายสั้น — ประโยคสอนใช้งาน 70 ตัวอักษรเดิมถูกพิมพ์ซ้ำทุกการ์ด (7 ครั้ง/จอ) ในตำแหน่งที่
              สายตาไปเป็นที่สอง และเด่นกว่าคำอธิบายจริง · ย้ายคำสอนไปแผงคู่มือ (ปุ่ม ?) แล้ว */}
          <div
            className="text-[10px] font-semibold tracking-wide text-sky-300"
            title="key ของ collection นี้ — ลากเส้นจากจุดข้างการ์ดเพื่อเชื่อมมาที่ key"
          >
            🔑 key
          </div>
          {soloKeys.map((f) => keyRow(f))}
          {/* กลุ่ม key ผสม — หลาย field รวมเป็น key เดียว; mapping ยังเป็น field→field แต่เส้นคู่กลุ่มเดียวกันถูกรวมตอน render */}
          {keyGroups.map((g) => (
            <div key={g.id} className="mt-0.5 rounded border border-sky-700/60 bg-sky-950/40 px-1 py-0.5">
              <div
                className="flex items-center justify-between gap-1 px-1 text-[10px] font-semibold text-sky-300/90"
                title={`key ผสม (กลุ่ม "${g.id}") — ${g.fields.length} field รวมเป็น key เดียว (${g.unique ? "compound unique index" : "compound index ธรรมดา"})`}
              >
                <span>
                  ⛓ key ผสม: {g.fields.map((f) => f.name).join(" + ")}
                  {g.fields.length < 2 && <span className="text-amber-400"> ⚠ ต้องมี ≥2 field</span>}
                </span>
                <span className="flex shrink-0 items-center">
                  {/* โหมดกลุ่ม: ห้ามซ้ำ (unique) ⇄ ซ้ำได้ (index เพื่อค้นเร็ว) */}
                  <button
                    className={`nodrag rounded border px-1 text-[10px] ${
                      g.unique
                        ? "border-amber-600/60 text-amber-300"
                        : "border-slate-500 text-slate-300 hover:text-slate-100"
                    }`}
                    title={g.unique ? "ห้ามซ้ำ — compound unique index (กดเพื่อเปลี่ยนเป็น ซ้ำได้)" : "ซ้ำได้ — compound index ธรรมดา เพื่อค้นเร็ว (กดเพื่อเปลี่ยนเป็น ห้ามซ้ำ)"}
                    onClick={() => setGroupUnique(g, !g.unique)}
                  >
                    {g.unique ? "ห้ามซ้ำ" : "ซ้ำได้"}
                  </button>
                  <button
                    className="nodrag mm-ico ml-1 text-slate-300 hover:bg-red-500/15 hover:text-red-400"
                    title={`ยกเลิก key ผสมทั้งกลุ่ม "${g.id}" (fields ยังอยู่)`}
                    onClick={() => removeGroup(g)}
                  >
                    ✕
                  </button>
                </span>
              </div>
              {g.fields.map((f, i) =>
                keyRow(f, {
                  first: i === 0,
                  last: i === g.fields.length - 1,
                  onUp: () => moveGroupMember(g, f.id, -1),
                  onDown: () => moveGroupMember(g, f.id, 1),
                  onRemove: () => removeFromGroup(f),
                  unique: g.unique,
                })
              )}
            </div>
          ))}
        </div>
      )}

      {!compact && (
        <div className="border-b border-slate-700/60 bg-slate-900/35 px-3 py-1">
          <div className="flex items-center justify-between text-[10px] font-semibold text-violet-300">
            <span title="Indexes เพิ่มเติมสำหรับรูปแบบ query นอกเหนือจาก unique, key ผสม และ relation">📇 indexes {data.indexes?.length ?? 0}</span>
            <button
              className="nodrag rounded px-1 text-xs text-violet-300 hover:bg-violet-500/15 hover:text-violet-200"
              title="เพิ่ม index"
              onClick={() => editIndex()}
            >
              ＋
            </button>
          </div>
          {(data.indexes ?? []).map((index) => (
            <div key={index.id} className="mt-0.5 flex items-center gap-1 rounded bg-slate-950/35 px-1.5 py-0.5">
              <span className="min-w-0 flex-1 truncate text-[10px] text-slate-300" title={indexText(index)}>
                {index.fields.map((part) => `${fieldPathById.get(part.field) ?? "⚠ ไม่พบ field"} ${part.direction === 1 ? "↑" : "↓"}`).join(" + ")}
              </span>
              {index.unique && <span className="rounded border border-amber-700/60 px-1 text-[9px] text-amber-300">unique</span>}
              {index.sparse && <span className="rounded border border-slate-600 px-1 text-[9px] text-slate-300">sparse</span>}
              <button className="nodrag mm-ico text-[10px] text-slate-400 hover:text-violet-300" title="แก้ index" onClick={() => editIndex(index)}>✎</button>
              <button className="nodrag mm-ico text-[10px] text-slate-400 hover:text-red-400" title="ลบ index" onClick={() => removeIndex(index.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {compact && (
        <div className="border-b border-slate-700/60 bg-slate-900/50 px-3 py-1 text-[10px] text-slate-400">
          {fieldEntries.length} ฟิลด์ · {keyFields.length} key · {data.indexes?.length ?? 0} index · ซูมเข้าเพื่อแก้
        </div>
      )}

      {/* รายการฟิลด์ — recursive ผ่าน FieldRow (nested document) */}
      <div className="divide-y divide-slate-700/60">
        {visibleFields.map((f) => {
          const fi = data.fields.findIndex((field) => field.id === f.id);
          return (
          <div
            key={f.id}
            // เส้นบอกตำแหน่งปลายทางตอนลากจัดลำดับ — เดิมต้องปล่อยก่อนถึงจะรู้ว่าไปลงตรงไหน
            className={`group px-3 py-1 ${dropAt === fi ? "border-t-2 border-sky-400" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIndex.current !== null && dropAt !== fi) setDropAt(fi);
            }}
            onDragLeave={() => setDropAt((d) => (d === fi ? null : d))}
            onDrop={() => {
              if (dragIndex.current !== null) reorderField(dragIndex.current, fi);
              dragIndex.current = null;
              setDropAt(null);
            }}
          >
            {compact ? (
              <div className="relative flex items-center gap-1 py-0.5 text-[10px] text-slate-300">
                <span className="font-medium">{f.name}</span>
                <span className="text-slate-500">{TYPE_ICON[f.type] ?? f.type}</span>
                <Handle type="target" position={Position.Left} id={`${f.id}-t-l`} className="!bg-amber-400" style={{ left: -24 }} />
                <Handle type="target" position={Position.Right} id={`${f.id}-t-r`} className="!bg-amber-400" style={{ right: -24 }} />
                <Handle type="source" position={Position.Left} id={`${f.id}-s-l`} style={{ left: -10 }} />
                <Handle type="source" position={Position.Right} id={`${f.id}-s-r`} style={{ right: -10 }} />
              </div>
            ) : (
              <FieldRow
                field={f}
                depth={0}
                topIndex={fi}
                siblings={data.fields}
                isPK={f.name === "_id" && data.fields.findIndex((o) => o.name === "_id") === fi}
                onPatch={patchField}
                onRemove={removeField}
                onAddChild={addChild}
                onEditDesc={editFieldDescription}
                onEditEnumDefault={editEnumDefault}
                onEditKeyGroup={editKeyGroup}
                onDuplicate={duplicateField}
                onAddAfterLast={addField}
                dragIndexRef={dragIndex}
              />
            )}
          </div>
          );
        })}
      </div>

      {!compact && <button
        className="nodrag w-full rounded-b-lg px-3 py-1.5 text-left text-xs text-sky-400 hover:bg-slate-700/50"
        onClick={addField}
      >
        ＋ เพิ่มฟิลด์
      </button>}

      {/* popup ป้อนรายละเอียด — portal ไป body ให้หลุด transform ของ canvas */}
      {editing &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
            onClick={closeEditing}
          >
            <div
              className="mm-panel w-full max-w-md p-5 text-sm"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeEditing();
              }}
            >
              <h3 className="mb-3 font-semibold text-slate-100">
                {editing.kind === "collDesc"
                  ? "คำอธิบายคอลเลกชัน"
                  : editing.kind === "fieldDesc"
                    ? `คำอธิบายฟิลด์ "${editing.name}"`
                    : editing.kind === "index"
                      ? editing.iid ? "แก้ index" : "เพิ่ม index"
                    : editing.kind === "keyGroup"
                      ? `key ผสม ของ "${editing.name}"`
                      : `enum / ค่าเริ่มต้น ของ "${editing.name}"`}
              </h3>

              {editing.kind === "index" ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      ฟิลด์ตามลำดับ — 1 บรรทัดต่อฟิลด์ (หรือคั่นด้วย comma) ใส่ :1 หรือ :-1
                    </label>
                    <textarea
                      autoFocus
                      rows={4}
                      className={`mm-input w-full resize-y px-3 py-2 font-mono text-sm ${editError ? "border-red-500" : ""}`}
                      placeholder={"holdingcode:1\ncreatedat:-1"}
                      value={editing.text}
                      onChange={(e) => {
                        setEditing({ ...editing, text: e.target.value });
                        setEditError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveEditing();
                      }}
                    />
                    {editError && <div className="mt-1 text-xs text-red-400">⚠ {editError}</div>}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={editing.unique} onChange={(e) => setEditing({ ...editing, unique: e.target.checked })} />
                    unique — ห้ามค่าซ้ำทั้งชุด
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={editing.sparse} onChange={(e) => setEditing({ ...editing, sparse: e.target.checked })} />
                    sparse — ข้ามเอกสารที่ไม่มีสมาชิก index เลย
                  </label>
                  <div className="text-xs text-slate-500">ใช้ dotted path กับฟิลด์ซ้อน เช่น address.city · Ctrl+Enter เพื่อบันทึก</div>
                </div>
              ) : editing.kind === "keyGroup" ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      id กลุ่ม key ผสม — fields ที่มี id เดียวกันรวมเป็น key เดียว (ว่าง = ออกจากกลุ่ม)
                    </label>
                    <input
                      autoFocus
                      className="mm-input w-full px-3 py-2 text-sm"
                      placeholder="เช่น barcode"
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && saveEditing()}
                    />
                  </div>
                  {/* กลุ่มที่มีอยู่ใน collection นี้ — กดเพื่อเลือก */}
                  {keyGroups.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-slate-500">กลุ่มที่มี:</span>
                      {keyGroups.map((g) => (
                        <button
                          key={g.id}
                          className={`rounded border px-2 py-0.5 ${
                            editing.text === g.id
                              ? "border-sky-500 bg-sky-900/50 text-sky-200"
                              : "border-slate-700 text-slate-300 hover:border-sky-700"
                          }`}
                          title={g.fields.map((f) => f.name).join(" + ")}
                          onClick={() => setEditing({ ...editing, text: g.id })}
                        >
                          ⛓ {g.id} ({g.fields.length})
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-slate-500">
                    key ผสม = หลาย field รวมกัน unique ร่วมกัน (compound unique index) เช่น holdingcode + itemcode + barcode
                  </div>
                </div>
              ) : editing.kind === "enumDefault" ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      enum — ค่าที่อนุญาต (คั่นด้วย , ว่าง = ลบ)
                    </label>
                    <input
                      autoFocus
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
                      placeholder="เช่น pending, paid, shipped"
                      value={editing.enumText}
                      onChange={(e) => setEditing({ ...editing, enumText: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && saveEditing()}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      ค่าเริ่มต้น (default • ว่าง = ลบ)
                    </label>
                    <input
                      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
                      value={editing.def}
                      onChange={(e) => setEditing({ ...editing, def: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && saveEditing()}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <textarea
                    autoFocus
                    rows={4}
                    className={`w-full resize-y rounded-lg border bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-sky-500 ${
                      editError ? "border-red-500" : "border-slate-700"
                    }`}
                    placeholder="พิมพ์คำอธิบายภาษาไทยที่นี่… (บังคับ)"
                    value={editing.text}
                    onChange={(e) => {
                      setEditing({ ...editing, text: e.target.value });
                      setEditError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveEditing();
                    }}
                  />
                  {editError ? (
                    <div className="mt-2 text-xs text-red-400">⚠ {editError}</div>
                  ) : (
                    <div className="mt-2 text-xs text-slate-500">บังคับ: ต้องเป็นคำอธิบายภาษาไทย</div>
                  )}
                </>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
                  onClick={closeEditing}
                >
                  ยกเลิก
                </button>
                <button
                  className="rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-500"
                  onClick={saveEditing}
                >
                  บันทึก
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {confirmDiscard && (
        <ConfirmDialog
          title="ทิ้งข้อความที่ยังไม่บันทึก?"
          description="ข้อความคำอธิบายที่พิมพ์ไว้จะหาย"
          confirmLabel="ทิ้งข้อความ"
          destructive
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** node เสมือนปลายทางเส้นข้าม tab — เส้นประทึบ + กดเพื่อข้ามไป tab นั้น (derive ตอน render ไม่ persist) */
function CrossRefNodeView({ data }: NodeProps<Node<CollectionData>>) {
  return (
    <div
      className="cursor-pointer rounded-lg border border-dashed border-amber-500/70 bg-slate-900/90 px-3 py-2 text-xs shadow-lg"
      title={`ไปที่แท็บ "${data.description ?? ""}"`}
    >
      <div className="font-semibold text-amber-300">{data.label}</div>
      <div className="text-slate-400">⇢ แท็บ “{data.description}” — กดเพื่อข้ามไป</div>
      {(data.refHandles ?? []).map((h, i) => {
        // handle canonical ลงท้าย -s (ต้นทาง/FK) หรือ -t (ปลายทาง) — stub ฝั่ง source เกิดจากข้อมูลเก่าที่เส้นค้างผิด diagram
        const type = /-s$/.test(h) ? ("source" as const) : ("target" as const);
        return (
          <span key={h}>
            <Handle type={type} position={Position.Left} id={`${h}-l`} className="!bg-amber-400" style={{ left: -10, top: 16 + i * 16 }} />
            <Handle type={type} position={Position.Right} id={`${h}-r`} className="!bg-amber-400" style={{ right: -10, top: 16 + i * 16 }} />
          </span>
        );
      })}
    </div>
  );
}

const nodeTypes = { collection: CollectionNodeView, crossref: CrossRefNodeView };

// ระยะเว้นจากจุดเชื่อมถึงปลายเส้น — react flow ตรึง marker ไว้ที่ refX=0 (ปลายแหลม = จุดปลาย path
// = ศูนย์กลาง handle พอดี) หัวลูกศรยาวแค่ ~7.5px จึงจมอยู่ในวงจุด (รัศมีที่มองเห็น ~8px) จนมองไม่เห็น
// ขยับปลาย path ออกก่อนวาดเอง = ลูกศรพ้นวงจุดและมีช่องว่างหายใจ (ลุคเดียวกับ Figma/Linear)
const EDGE_GAP_SOURCE = 17; // ฝั่งลูก — มีหัวลูกศร ต้องเว้นมากกว่า
const EDGE_GAP_TARGET = 12; // ฝั่งแม่ — ปลายเปล่า เว้นพอไม่ให้เส้นเสียบทับจุด

/** ขยับจุดปลายออกจากการ์ดตามข้างที่ handle อยู่ */
function shiftEndpoint(x: number, y: number, pos: Position, d: number): [number, number] {
  if (pos === Position.Left) return [x - d, y];
  if (pos === Position.Right) return [x + d, y];
  if (pos === Position.Top) return [x, y - d];
  return [x, y + d];
}

/**
 * เส้น relation — bezier เหมือนเดิมทุกอย่าง ต่างแค่ (1) เว้นช่องว่างที่ปลายทั้งสองข้าง
 * (2) ป้ายชื่อ field อยู่กึ่งกลางเส้นตามตำแหน่งที่ React Flow คำนวณให้
 */
function RelEdgeView({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerStart, label, data,
}: EdgeProps) {
  // relation ของ key ผสมยังเก็บ mapping ราย field ครบ แต่ซ่อนเส้นย่อยและวาดเส้นสรุปเส้นเดียวแทน
  if ((data as DisplayRelData | undefined)?.hiddenComposite) return null;
  const [sx, sy] = shiftEndpoint(sourceX, sourceY, sourcePosition, EDGE_GAP_SOURCE);
  const [tx, ty] = shiftEndpoint(targetX, targetY, targetPosition, EDGE_GAP_TARGET);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition,
    targetX: tx, targetY: ty, targetPosition,
  });
  const dim = typeof style?.opacity === "number" && style.opacity < 0.5;
  const compositeCount = (data as DisplayRelData | undefined)?.compositeEdgeIds?.length ?? 0;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerStart={markerStart} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`mm-edge-label nodrag nopan ${compositeCount ? "cursor-pointer" : ""}`}
            title={compositeCount ? `key ผสม ${compositeCount} คู่ · คลิกเพื่อดู mapping` : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: dim ? 0.5 : 1 }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { rel: RelEdgeView };

// ---------- ธีมมืด/สว่าง ----------
// เก็บที่ localStorage + เขียนลง <html data-theme> ให้ css สลับสเกลสีทั้งชุด (ดู globals.css)
type Theme = "dark" | "light";
const THEME_KEY = "mongomodel-theme";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    // ไม่เคยเลือก = ตามค่าระบบ
    const initial: Theme =
      saved === "light" || saved === "dark"
        ? saved
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    const frame = window.requestAnimationFrame(() => setTheme(initial));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  // ข้ามรอบแรก — สคริปต์ใน layout.tsx เขียน data-theme ที่ถูกต้องให้ตั้งแต่ก่อน hydrate แล้ว
  // ถ้าเขียนทับด้วย state ตั้งต้น ("dark") จะได้จอกระพริบดำหนึ่งเฟรมทุกครั้งที่โหลดในโหมดสว่าง
  const themeBooted = useRef(false);
  useEffect(() => {
    if (!themeBooted.current) {
      themeBooted.current = true;
      return;
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

/** ปุ่มสลับธีมบน toolbar */
function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      className="mm-btn px-2.5"
      title={theme === "dark" ? "สลับเป็นโหมดสว่าง" : "สลับเป็นโหมดมืด"}
      onClick={onToggle}
    >
      {theme === "dark" ? "☀️" : "🌙"}
    </button>
  );
}

type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
};

/** กล่องยืนยันของแอป — ใช้แทน native confirm ซึ่งถูก auto-dismiss ได้ใน automation/บาง browser */
function ConfirmDialog({
  title,
  description,
  confirmLabel = "ยืนยัน",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        className="mm-modal mm-panel w-full max-w-sm p-5 text-sm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 font-semibold text-slate-100">{title}</h3>
        <p className="mb-4 whitespace-pre-line text-xs leading-relaxed text-slate-400">{description}</p>
        <div className="flex justify-end gap-2">
          <button
            autoFocus
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            onClick={onCancel}
          >
            ยกเลิก
          </button>
          <button
            className={`rounded-lg px-3 py-1.5 font-medium text-white ${
              destructive ? "bg-red-600 hover:bg-red-500" : "bg-sky-600 hover:bg-sky-500"
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------- จัดการ diagram ใน localStorage ----------

function loadIndex(): { tabs: DiagramMeta[]; cur: string } {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw) {
      const idx = JSON.parse(raw);
      if (Array.isArray(idx.tabs) && idx.tabs.length && idx.tabs.find((t: DiagramMeta) => t.id === idx.cur)) {
        return idx;
      }
    }
  } catch {}
  // migrate จากเวอร์ชันเก่า (key เดียว) หรือเริ่มใหม่
  const id = uid();
  const legacy = localStorage.getItem(LEGACY_KEY);
  localStorage.setItem(
    dataKey(id),
    legacy ?? JSON.stringify({ nodes: starterNodes, edges: starterEdges })
  );
  localStorage.removeItem(LEGACY_KEY);
  const idx = { tabs: [{ id, name: "Main Diagram" }], cur: id };
  localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  return idx;
}

function loadDiagram(id: string): { nodes: CollectionNode[]; edges: RelEdge[] } {
  try {
    const raw = localStorage.getItem(dataKey(id));
    if (raw) {
      const { nodes, edges } = JSON.parse(raw);
      if (Array.isArray(nodes) && Array.isArray(edges)) return persistedFlowDiagram(nodes, edges);
    }
  } catch {}
  return { nodes: [], edges: [] };
}

// parse ไฟล์นำเข้าเป็นรายการ diagram — รับทั้งแบบเดี่ยว {nodes,edges} และแบบสำรองทั้งชุด {diagrams:[]}
// (ใช้ร่วมกันทั้งหน้าโปรเจกต์ — นำเข้าเป็น project ใหม่ และตัว designer — นำเข้าเป็นแท็บ)
function parseDiagramFile(raw: string, fallback: string) {
  const parsed = JSON.parse(raw);
  const list: { name: string; nodes: CollectionNode[]; edges: RelEdge[] }[] = [];
  if (Array.isArray(parsed?.diagrams)) {
    for (const d of parsed.diagrams) {
      if (!Array.isArray(d?.nodes) || !Array.isArray(d?.edges)) throw new Error();
      const persisted = persistedFlowDiagram<CollectionNode, RelEdge>(d.nodes, d.edges);
      list.push({
        name: typeof d.name === "string" && d.name ? d.name : fallback,
        ...persisted,
      });
    }
  } else if (Array.isArray(parsed?.nodes) && Array.isArray(parsed?.edges)) {
    const persisted = persistedFlowDiagram<CollectionNode, RelEdge>(parsed.nodes, parsed.edges);
    list.push({
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallback,
      ...persisted,
    });
  }
  if (!list.length) throw new Error();
  return list;
}

// อ่านไฟล์ JSON แล้ว parse เป็นรายการ diagram — ไฟล์ไม่ถูกต้องแจ้งเตือนเอง
function readFile(file: File, apply: (list: ReturnType<typeof parseDiagramFile>) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      apply(parseDiagramFile(String(reader.result), file.name.replace(/\.json$/i, "")));
    } catch {
      alert("ไฟล์ไม่ถูกต้อง — ต้องเป็น JSON ที่ส่งออกจาก MongoModel");
    }
  };
  reader.readAsText(file);
}

// ---------- ศูนย์ส่งออกโค้ด ----------

const CODE_TABS = ["mongosh", "Go", "Mongoose", "TypeScript", "Markdown", "Wiki", "ตัวอย่าง", "JSON"] as const;
type CodeTab = (typeof CODE_TABS)[number];

// ---------- undo / redo ----------

const HISTORY_CAP = 50;

// snapshot เป็น JSON string — ตัด state ชั่วคราว (selected/dragging/measured/label ที่ derive ใหม่ได้)
// จะได้ไม่เกิด history entry ปลอมจากการคลิกเลือก node หรือ label sync
const serializeSnapshot = (nodes: CollectionNode[], edges: RelEdge[]): string =>
  JSON.stringify(persistedFlowDiagram(nodes, edges));

// ---------- หน้าหลัก (designer ของ project หนึ่งตัว) ----------

function Designer({
  project,
  offline,
  onExit,
  onShowWiki,
  wikiOpen,
  theme,
  onToggleTheme,
}: {
  project: string; // ชื่อ project บน server — source of truth
  offline: boolean; // true = โหมดออฟไลน์ (localStorage ล้วน ไม่มีระบบ project)
  onExit: () => void; // กลับไปหน้าเลือกโปรเจกต์
  onShowWiki: (name: string) => void; // toggle wiki ข้าง canvas (หน้าเดียวกัน)
  wikiOpen: boolean; // wiki ของโปรเจกต์นี้เปิดอยู่ไหม (ไฮไลต์ปุ่ม)
  theme: Theme; // ธีมปัจจุบัน — ส่งต่อให้ react flow ด้วย (colorMode)
  onToggleTheme: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CollectionNode>([]);
  const [edges, setEdges, applyEdgeChanges] = useEdgesState<RelEdge>([]);
  const [tabs, setTabs] = useState<DiagramMeta[]>([]);
  const [cur, setCur] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [inspectedEdgeId, setInspectedEdgeId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false); // ปุ่ม ? คู่มือบน canvas
  const [navOpen, setNavOpen] = useState(false); // เริ่มแบบพับ ไม่บัง collection ซ้ายสุด; กดขยายเมื่อต้องใช้
  const [navQuery, setNavQuery] = useState("");
  const [codeTab, setCodeTab] = useState<CodeTab>("mongosh");
  const [copied, setCopied] = useState<"ok" | "err" | null>(null); // ผลของปุ่ม 📋 คัดลอก
  const [saveError, setSaveError] = useState(false);
  const [externalEdit, setExternalEdit] = useState(false);
  const [aiNotice, setAiNotice] = useState(""); // toast หลัง auto refresh — ข้อความบอกด้วยว่าประวัติ undo ถูกล้างไหม
  const [sweepNotice, setSweepNotice] = useState(""); // toast แจ้งกวาดเส้นค้างในแท็บอื่นหลังลบ node/field (ห้ามลบเงียบ)
  // timer ของ toast — เดิมตั้ง setTimeout ใหม่โดยไม่ล้างตัวเก่า toast อันที่สองจึงถูกฆ่าก่อนเวลา
  // ด้วย timer ของอันแรก (วัดได้ 1877ms จากที่ตั้งไว้ 2500ms)
  const noticeTimer = useRef<number | undefined>(undefined);
  const sweepTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((msg: string, ms = 3000) => {
    window.clearTimeout(noticeTimer.current);
    setAiNotice(msg);
    noticeTimer.current = window.setTimeout(() => setAiNotice(""), ms);
  }, []);
  const notifySweep = useCallback((msg: string, ms = 6000) => {
    window.clearTimeout(sweepTimer.current);
    setSweepNotice(msg);
    sweepTimer.current = window.setTimeout(() => setSweepNotice(""), ms);
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(noticeTimer.current);
      window.clearTimeout(sweepTimer.current);
    },
    []
  );
  // เมนูคลิกขวาของแอป (การ์ด/เส้น/พื้นที่ว่าง) — ความเคยชินจาก Figma/Explorer
  const [ctxMenu, setCtxMenu] = useState<
    | ({ x: number; y: number } & ({ kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "pane" }))
    | null
  >(null);
  const [histOpen, setHistOpen] = useState(false); // modal ประวัติการแก้ไข (snapshot ฝั่ง server)
  const [revisions, setRevisions] = useState<{ rev: number; savedAt: string }[] | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<
    (ConfirmOptions & { resolve: (answer: boolean) => void }) | null
  >(null);
  const [tbOverflow, setTbOverflow] = useState(false); // toolbar ล้นขวา — โชว์ตัวบอก » ว่ายังมีปุ่มซ่อนอยู่
  const copyRef = useRef<CollectionNode | null>(null); // clipboard ภายในแอป — Ctrl+C เก็บการ์ด, Ctrl+V วางสำเนา
  const toolbarRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadedId = useRef(""); // diagram id ที่โหลดเข้า state แล้ว (กัน autosave ก่อนโหลด)
  // sync กับ server (/api/project) — server เป็น source of truth ที่ AI (MCP) เห็นด้วย
  const diagramsMap = useRef<Record<string, { nodes: CollectionNode[]; edges: RelEdge[] }>>({});
  // เวอร์ชัน reactive ของ diagram ทุกแท็บ (ตั้งตอนโหลด/refresh) — ใช้ตอน render (กฎ react-hooks ห้ามอ่าน ref ระหว่าง render)
  const [allDiagrams, setAllDiagrams] = useState<Record<string, { nodes: CollectionNode[]; edges: RelEdge[] }>>({});
  const knownRev = useRef<number | null>(null); // rev ล่าสุดที่ UI รู้ — ต่างจาก server = มีคนอื่นแก้
  const lastPayload = useRef(""); // payload ล่าสุดที่ server มี — กัน autosave ยิง PUT ซ้ำตอน refresh/โหลด (ไม่งั้น rev ไถลและของที่ AI ลบเด้งกลับ)
  const serverOn = useRef(false); // bootstrap ต่อ server ได้ไหม — ไม่ได้ = โหมด offline (localStorage ล้วน)
  // PUT เจอ 409 ค้างอยู่ — local มีการแก้ที่ยังไม่ถูก push ห้าม poll เอาของ server มาทับเงียบ (ต้องรอผู้ใช้กดโหลดที่แถบเตือน)
  const conflict = useRef(false);
  // serialize PUT เป็นคิวเดียว — สอง PUT ที่วิ่งพร้อมกันอ่าน knownRev ตัวเดียวกัน ตัวหลังจะ 409 ชนกับตัวเอง
  // แล้ว save/poll ค้างทั้งเซสชัน (การแก้หลังจากนั้นดูเหมือนสำเร็จบนจอแต่ไม่ถูกบันทึกจริง)
  const putChain = useRef<Promise<void>>(Promise.resolve());
  const saving = useRef(false); // PUT กำลังวิ่ง — poll ห้ามตีความ rev ที่ขยับว่าเป็นของคนอื่น
  const { fitView, getViewport, setViewport, getInternalNode, deleteElements, screenToFlowPosition } =
    useReactFlow<CollectionNode>();

  const askConfirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setConfirmRequest({ ...options, resolve })),
    []
  );
  const settleConfirm = (answer: boolean) => {
    const resolve = confirmRequest?.resolve;
    setConfirmRequest(null);
    resolve?.(answer);
  };

  // Ctrl+ลากซ้าย = แพนจออิสระ (wheel/ctrl+wheel ใช้ native props ของ React Flow ด้านล่าง)
  // ทำเองที่ capture phase ของ root — d3-zoom/selection ของ React Flow ไม่ครอบ gesture นี้
  // หมายเหตุ: Ctrl+คลิก multi-select ถูกแย่งทับด้วย gesture นี้ (เลือกหลายอันใช้ลากกรอบได้อยู่แล้ว)
  useEffect(() => {
    const el = document.querySelector(".react-flow");
    if (!el) return;
    let panStart: { px: number; py: number; vx: number; vy: number } | null = null;

    const onDown = (e: Event) => {
      const pe = e as PointerEvent;
      if (!pe.ctrlKey || pe.button !== 0) return;
      pe.preventDefault();
      pe.stopImmediatePropagation();
      const vp = getViewport();
      panStart = { px: pe.clientX, py: pe.clientY, vx: vp.x, vy: vp.y };
      (e.target as Element).setPointerCapture?.(pe.pointerId);
    };
    const onMove = (e: Event) => {
      if (!panStart) return;
      const pe = e as PointerEvent;
      pe.stopImmediatePropagation();
      const vp = getViewport();
      setViewport({
        x: panStart.vx + (pe.clientX - panStart.px),
        y: panStart.vy + (pe.clientY - panStart.py),
        zoom: vp.zoom,
      });
    };
    const onUp = () => {
      panStart = null;
    };

    el.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp, { capture: true });
    };
  }, [getViewport, setViewport]);

  // undo/redo — stack ของ snapshot ต่อ diagram ปัจจุบัน (ล้างตอน openDiagram)
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const present = useRef(""); // snapshot ล่าสุดที่ commit เข้า history แล้ว
  const skipHistory = useRef(false); // true = การเปลี่ยน nodes/edges รอบนี้มาจาก undo/redo เอง
  const [histSizes, setHistSizes] = useState({ past: 0, future: 0 }); // ให้ปุ่ม ↶↷ รู้ว่ากดได้ไหม

  const syncHistSizes = () =>
    setHistSizes({ past: past.current.length, future: future.current.length });

  const openDiagram = (id: string, preserveView = false) => {
    // อ่านจาก map (ข้อมูล server) ก่อน — localStorage เป็น fallback (โหมด offline / tab ที่ยังไม่เคยเปิด)
    const d = diagramsMap.current[id] ?? loadDiagram(id);
    setNodes(d.nodes);
    setEdges(d.edges);
    setCur(id);
    setInspectedEdgeId(null);
    loadedId.current = id;
    // ล้าง history — undo ไม่ข้าม diagram
    past.current = [];
    future.current = [];
    present.current = serializeSnapshot(d.nodes, d.edges);
    skipHistory.current = false;
    syncHistSizes();
    // preserveView = auto refresh จาก server — ไม่แตะมุมมองกันจอเด้ง
    if (!preserveView) {
      // มี viewport ที่จำไว้ = กลับไปตำแหน่ง/ซูมเดิม, ไม่มี = fit view ตามเดิม
      // ยิงซ้ำที่ 300ms เผื่อรอบแรก React Flow ยังวัด node ไม่เสร็จ (โหลดครั้งแรก fitView จะเงียบ)
      const restore = () => {
        const vp = loadVp(id);
        if (vp) setViewport(vp);
        else void fitView({ padding: 0.1 });
      };
      setTimeout(restore, 50);
      setTimeout(restore, 300);
    }
  };

  // โหลด index + diagram แรกตอน mount — ย้ายไปอยู่หลัง bootstrap (react-hooks/immutability ห้ามเรียกก่อนประกาศ)

  // เขียน localStorage แบบกัน quota เต็ม — พังเมื่อไหร่ขึ้นแถบเตือน, สำเร็จเมื่อไหร่เคลียร์
  const trySave = useCallback((key: string, value: string): boolean => {
    try {
      localStorage.setItem(key, value);
      setSaveError(false);
      return true;
    } catch {
      setSaveError(true);
      return false;
    }
  }, []);

  // PUT project ทั้งก้อนขึ้น server — เข้าคิวทีละตัว (serialize) ให้แต่ละ PUT อ่าน knownRev "หลัง"
  // ตัวก่อนหน้าจบแล้วเสมอ ไม่มีทางยิงซ้อนด้วย rev เก่าแล้ว 409 ชนกับตัวเอง
  const pushToServer = useCallback(
    (payload: string, force = false) => {
      if (!serverOn.current) return;
      putChain.current = putChain.current.then(async () => {
        // มี conflict ค้าง — ยิงต่อไปก็ 409 รัวๆ รอผู้ใช้เลือกที่แถบเตือน (โหลดจาก server / บันทึกทับ)
        if (conflict.current && !force) return;
        saving.current = true;
        try {
          // แนบ rev ที่ถืออยู่ — ถ้ามีคนอื่น (แท็บอื่น/AI ผ่าน MCP) เขียนไปก่อน server จะตอบ 409
          // แทนที่จะทับงานเขาหายเงียบ · force (ผู้ใช้กด "บันทึกทับ" เอง) = ไม่แนบ rev เขียนทับเลย
          const body = JSON.stringify({
            ...JSON.parse(payload),
            ...(force ? {} : { expectedRev: knownRev.current }),
          });
          const res = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (res.status === 409) {
            conflict.current = true; // ระงับ auto refresh — ไม่งั้น poll รอบถัดไปทับการแก้ที่เพิ่งชนหายเงียบ
            setExternalEdit(true); // แถบเตือน "การแก้ล่าสุดยังไม่ถูกบันทึก — เลือกโหลด/บันทึกทับ"
            return;
          }
          if (res.ok) {
            const j = await res.json();
            if (typeof j.rev === "number") knownRev.current = j.rev;
            lastPayload.current = payload;
            // ปลุกแท็บอื่นใน browser เดียวกันทันทีหลัง server รับข้อมูลแล้ว; คนละ browser ยังมี poll สำรอง
            if (typeof j.rev === "number")
              try {
                localStorage.setItem(`mongomodel:server-rev:${project}`, `${j.rev}:${Date.now()}`);
              } catch {}
            if (force) {
              conflict.current = false;
              setExternalEdit(false);
            }
          }
        } catch {
          // server หลุด — localStorage ยังเก็บอยู่
        } finally {
          saving.current = false;
        }
      });
    },
    [project]
  );

  // bootstrap: โหลด project จาก server (source of truth ที่ AI ผ่าน MCP เห็นด้วย)
  // offline = โหมดออฟไลน์ localStorage ล้วน · server หลุด/project หาย = กลับหน้าเลือกโปรเจกต์
  async function bootstrap() {
    if (offline) {
      const idx = loadIndex();
      setTabs(idx.tabs);
      openDiagram(idx.cur);
      return;
    }
    type SP = {
      rev: number;
      tabs: DiagramMeta[];
      cur: string;
      diagrams: Record<string, { nodes: CollectionNode[]; edges: RelEdge[] }>;
    };
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}`);
      if (!res.ok) throw new Error();
      const p = (await res.json()) as SP;
      if (!Array.isArray(p.tabs) || typeof p.diagrams !== "object" || p.tabs.length === 0)
        throw new Error();
      serverOn.current = true;
      knownRev.current = p.rev;
      const cleanDiagrams = persistedDiagramMap(p.diagrams);
      diagramsMap.current = cleanDiagrams;
      setAllDiagrams(cleanDiagrams);
      lastPayload.current = JSON.stringify({ tabs: p.tabs, cur: p.cur, diagrams: p.diagrams });
      // mirror ลง localStorage ไว้เป็น offline cache
      trySave(INDEX_KEY, JSON.stringify({ tabs: p.tabs, cur: p.cur }));
      for (const t of p.tabs) {
        trySave(dataKey(t.id), JSON.stringify(cleanDiagrams[t.id] ?? { nodes: [], edges: [] }));
      }
      setTabs(p.tabs);
      openDiagram(p.cur);
    } catch {
      onExit();
    }
  }

  // โหลดตอน mount — defer 1 tick กัน setState กลาง effect flush
  // server เป็น source of truth (AI ผ่าน MCP แก้ได้) — ต่อไม่ได้ค่อย fallback เป็น localStorage ล้วน
  useEffect(() => {
    const t = setTimeout(() => void bootstrap(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // แท็บใน browser เดียวกันใช้ storage signal ให้ sync ทันที; poll 1 วิเป็น fallback สำหรับคนละ browser/AI
  useEffect(() => {
    const check = () => {
      if (!serverOn.current || knownRev.current === null) return;
      // มี conflict (409) ค้าง — local ถือการแก้ที่ server ยังไม่รับ ห้าม auto ทับเงียบ รอผู้ใช้เลือกที่แถบเตือน
      // PUT กำลังวิ่ง — rev บน server กำลังขยับจาก save ของเราเอง รอบหน้าค่อยเช็ค (กัน false-positive "AI แก้")
      if (conflict.current || saving.current) return;
      void (async () => {
        try {
          const res = await fetch(
            `/api/projects/${encodeURIComponent(project)}?rev=${knownRev.current}`
          );
          if (res.status === 204) return; // rev เดิม — ไม่มีอะไรเปลี่ยน
          if (res.status === 404) {
            onExit(); // project ถูกลบจากที่อื่น — กลับหน้าเลือกโปรเจกต์
            return;
          }
          if (!res.ok) return;
          const p = await res.json();
          // ระหว่างรอ fetch อาจมี PUT เริ่ม/ชน 409 — ผลจาก server ยังไม่นิ่ง รอบหน้าเช็คใหม่
          if (conflict.current || saving.current) return;
          // rev เดินหน้าอย่างเดียว: response ที่ rev ≤ ของเรา = ค้างมาจากก่อน save ของเราเสร็จ ห้ามเอามาทับ
          const kr = knownRev.current;
          if (typeof p.rev !== "number" || kr === null || p.rev <= kr) return;
          const payload = JSON.stringify({ tabs: p.tabs, cur: p.cur, diagrams: p.diagrams });
          if (payload === lastPayload.current) {
            // echo ของ save ตัวเอง (poll เห็น rev ใหม่ก่อน handler ของ PUT อัปเดต knownRev)
            // — ห้ามขึ้นแถบ "อัปเดตจาก AI" และห้าม openDiagram ทับ state (จะกลืนคลิก/toggle ที่เพิ่งกด)
            knownRev.current = p.rev;
            return;
          }
          knownRev.current = p.rev;
          // auto refresh — เอาของใหม่จาก server มาทับ (preserveView กันจอเด้ง)
          const cleanDiagrams = persistedDiagramMap(p.diagrams);
          diagramsMap.current = cleanDiagrams;
          setAllDiagrams(cleanDiagrams);
          lastPayload.current = payload;
          setTabs(p.tabs);
          const id = cleanDiagrams[p.cur] ? p.cur : p.tabs[0]?.id;
          // ประวัติ undo เป็นของ state ชุดเก่า — openDiagram ล้างทิ้ง ต้องบอกผู้ใช้ตรงๆ (ไม่ให้กด Ctrl+Z แล้วงง)
          const histLost = past.current.length > 0 || future.current.length > 0;
          if (id) openDiagram(id, true);
          // ข้อความกลางๆ — แยกไม่ได้ว่าใครแก้ (แท็บอื่นของผู้ใช้เอง หรือ AI ผ่าน MCP) ห้ามชี้เฉพาะว่าเป็น AI
          notify(
            histLost
              ? "🔄 มีการแก้ไขจากที่อื่น (แท็บ/อุปกรณ์อื่น หรือ AI ผ่าน MCP) — อัปเดตให้แล้ว · ประวัติย้อนกลับ (Ctrl+Z) ของแท็บนี้ถูกล้างเพราะโหลดข้อมูลชุดใหม่"
              : "🔄 มีการแก้ไขจากที่อื่น (แท็บ/อุปกรณ์อื่น หรือ AI ผ่าน MCP) — อัปเดตให้แล้ว",
            histLost ? 6000 : 3000
          );
        } catch {
          // เงียบ — รอบหน้าลองใหม่
        }
      })();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === `mongomodel:server-rev:${project}`) check();
    };
    window.addEventListener("storage", onStorage);
    const t = setInterval(check, 1000);
    return () => {
      clearInterval(t);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // บันทึก index เมื่อ tabs/cur เปลี่ยน — defer 1 tick เพราะ trySave แตะ setSaveError
  useEffect(() => {
    if (!tabs.length) return;
    const t = setTimeout(() => trySave(INDEX_KEY, JSON.stringify({ tabs, cur })), 0);
    return () => clearTimeout(t);
  }, [tabs, cur, trySave]);

  // บันทึกอัตโนมัติ (หน่วง 400ms) — localStorage + server (server เป็น truth ที่ AI เห็น)
  // PUT เฉพาะตอน payload ต่างจากที่ server มีจริงๆ — กัน refresh แล้วยิงกลับ (rev ไถล/ของที่ AI ลบเด้ง)
  useEffect(() => {
    if (!cur || loadedId.current !== cur) return;
    const t = setTimeout(() => {
      const persisted = persistedFlowDiagram(nodes, edges);
      trySave(dataKey(cur), JSON.stringify(persisted));
      diagramsMap.current[cur] = persisted;
      // กวาดเส้นค้างในแท็บอื่นที่ชี้มาหา node/field ที่ถูกลบ — ทำตรงนี้ที่เดียว (ทุกทางลบผ่าน autosave)
      // เขียนขึ้น server ไปกับ payload เดียวกับ save ปกติ = ใช้ rev/409 เดิม ไม่มีเส้นทางเขียนใหม่
      // guard: เห็นครบทุกแท็บเท่านั้น (โหมด offline แท็บที่ยังไม่เคยเปิดไม่อยู่ใน map — universe ไม่ครบ ห้ามกวาด)
      if (tabs.every((tb) => diagramsMap.current[tb.id])) {
        const swept = sweepCrossTabEdges(diagramsMap.current, cur);
        if (swept.removed) {
          for (const tid of swept.tabIds)
            trySave(dataKey(tid), JSON.stringify(diagramsMap.current[tid]));
          setAllDiagrams({ ...diagramsMap.current }); // crossref stub/lint คำนวณใหม่ทันที
          const names = swept.tabIds
            .map((tid) => tabs.find((tb) => tb.id === tid)?.name ?? tid)
            .join(", ");
          // undo (Ctrl+Z) เป็น history ต่อ diagram ปัจจุบันเท่านั้น — เส้นที่กวาดในแท็บอื่นไม่คืน ต้องบอกตรงๆ
          notifySweep(
            `ลบเส้นข้ามแท็บที่ค้าง ${swept.removed} เส้น (แท็บ: ${names}) — ปลายทางถูกลบไปแล้ว · Ctrl+Z ไม่คืนเส้นนี้ (กู้ได้ผ่าน MCP list_revisions/restore_revision)`
          );
        }
      }
      const payload = JSON.stringify({ tabs, cur, diagrams: diagramsMap.current });
      if (payload !== lastPayload.current) void pushToServer(payload);
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, cur, tabs, trySave, pushToServer, notifySweep]);

  const saveNow = useCallback(() => {
    if (cur) {
      const persisted = persistedFlowDiagram(nodes, edges);
      trySave(dataKey(cur), JSON.stringify(persisted));
      diagramsMap.current[cur] = persisted;
    }
  }, [cur, nodes, edges, trySave]);

  // commit state ปัจจุบันเข้า history (ถ้าเปลี่ยนจริง) — เรียกจาก debounce และก่อน undo/redo
  const commitHistory = useCallback(() => {
    const s = serializeSnapshot(nodes, edges);
    if (s === present.current) return;
    past.current.push(present.current);
    if (past.current.length > HISTORY_CAP) past.current.shift();
    present.current = s;
    future.current = []; // edit ใหม่ = branch ใหม่ ล้าง redo
    syncHistSizes();
  }, [nodes, edges]);

  // push snapshot แบบ debounce 400ms (จังหวะเดียวกับ autosave) — ข้ามรอบที่มาจาก undo/redo
  useEffect(() => {
    if (!cur || loadedId.current !== cur) return;
    if (skipHistory.current) {
      skipHistory.current = false;
      return;
    }
    const t = setTimeout(commitHistory, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, cur, commitHistory]);

  const undo = useCallback(() => {
    commitHistory(); // edit ที่ยังไม่ถึง debounce = ขั้นแรกที่ต้อง undo ไม่ใช่ของหาย
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(present.current);
    present.current = prev;
    skipHistory.current = true;
    const d = JSON.parse(prev) as { nodes: CollectionNode[]; edges: RelEdge[] };
    setNodes(d.nodes);
    setEdges(d.edges);
    syncHistSizes();
  }, [commitHistory, setNodes, setEdges]);

  const redo = useCallback(() => {
    commitHistory(); // มี edit ค้าง = branch ใหม่ future ถูกล้างไปแล้ว → no-op ที่ถูกต้อง
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(present.current);
    present.current = next;
    skipHistory.current = true;
    const d = JSON.parse(next) as { nodes: CollectionNode[]; edges: RelEdge[] };
    setNodes(d.nodes);
    setEdges(d.edges);
    syncHistSizes();
  }, [commitHistory, setNodes, setEdges]);

  // มีการแก้ที่ยังไม่ commit เข้า history (debounce 400ms) — ปุ่ม ↶ ต้อง enable ทันทีหลังแก้
  // ไม่รอ debounce (undo() เรียก commitHistory เองก่อน pop จึงกดได้เลย)
  const dirty = useMemo(() => {
    // อ่าน ref อย่างเดียว: present เปลี่ยนเฉพาะตอน commit/undo ซึ่งมาพร้อม setNodes/setEdges
    // (memo คำนวณใหม่รอบเดียวกัน) จึงไม่มี stale render; เก็บเป็น state จะกลายเป็น setState ใน effect
    // eslint-disable-next-line react-hooks/refs
    return Boolean(cur) && serializeSnapshot(nodes, edges) !== present.current;
  }, [nodes, edges, cur]);

  // กันปิดแท็บก่อน autosave 400ms ทำงาน
  useEffect(() => {
    window.addEventListener("beforeunload", saveNow);
    return () => window.removeEventListener("beforeunload", saveNow);
  }, [saveNow]);

  // แท็บเบราว์เซอร์อื่นแก้ diagram เดียวกัน → เตือนกันงานทับ (เฉพาะโหมดออฟไลน์ — โหมด server ใช้ auto refresh แทน)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (serverOn.current) return;
      if (e.key === dataKey(cur) || e.key === INDEX_KEY) setExternalEdit(true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [cur]);

  const switchTab = (id: string) => {
    if (id === cur) return;
    saveNow();
    openDiagram(id);
  };

  const newTab = () => {
    saveNow();
    const id = uid();
    trySave(dataKey(id), JSON.stringify({ nodes: [], edges: [] }));
    diagramsMap.current[id] = { nodes: [], edges: [] };
    setTabs((ts) => [...ts, { id, name: `Diagram ${ts.length + 1}` }]);
    openDiagram(id);
  };

  const closeTab = async (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (
      !(await askConfirm({
        title: `ลบ diagram “${tab?.name ?? id}” ?`,
        description: "ลบแท็บนี้พร้อม collection และ relation ภายในทั้งหมด",
        confirmLabel: "ลบ diagram",
        destructive: true,
      }))
    )
      return;
    localStorage.removeItem(dataKey(id));
    localStorage.removeItem(vpKey(id)); // viewport ที่จำไว้ของแท็บนี้ไม่มีประโยชน์แล้ว
    delete diagramsMap.current[id];
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) {
      // เหลือ 0 → สร้างอันใหม่ว่างๆ
      const nid = uid();
      trySave(dataKey(nid), JSON.stringify({ nodes: [], edges: [] }));
      diagramsMap.current[nid] = { nodes: [], edges: [] };
      setTabs([{ id: nid, name: "Main Diagram" }]);
      openDiagram(nid);
      return;
    }
    setTabs(rest);
    if (id === cur) openDiagram(rest[0].id);
  };

  const renameTab = (id: string, name: string) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, name } : t)));

  // จับ ▦ ที่แท็บลากปล่อยเพื่อจัดลำดับ — autosave (deps tabs) จะ PUT ขึ้น server ให้เอง
  const tabDrag = useRef<number | null>(null); // index ของแท็บที่กำลังลาก
  const reorderTab = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setTabs((ts) => {
      const next = [...ts];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return; // ไม่เชื่อมตัวเอง
      // handle จริงมี suffix ข้าง (-l/-r) — เก็บ canonical -s/-t เสมอ (ข้างเลือกอัตโนมัติตอน render)
      const norm = (h?: string | null): string | null => (h == null ? null : h.replace(/(-[st])-[lr]$/, "$1"));
      const cc: Connection = { ...c, sourceHandle: norm(c.sourceHandle), targetHandle: norm(c.targetHandle) };
      // 1 ฟิลด์ = 1 ref — ลากซ้ำจาก handle เดิม = ย้าย reference (ตรง buildRefMap last-write-wins)
      setEdges((es) =>
        addEdge(cc, es.filter((e) => !(e.source === cc.source && e.sourceHandle === cc.sourceHandle)))
      );
    },
    [setEdges]
  );

  // virtual node สำหรับเป้าหมายเส้นข้าม tab (edge target อยู่คนละ diagram) — derive ตอน render ไม่ persist
  // สำคัญ: อ้างตำแหน่งจาก allDiagrams (เปลี่ยนเฉพาะตอนโหลด/refresh) ไม่ใช่ nodes state —
  // ถ้าอ้าง nodes, object ถูกสร้างใหม่ทุกครั้งที่ RF วัดขนาด node → handle registration หลุด
  // (measured:{} ไม่มี handleBounds → isNodeInitialized false → เส้นไม่เรนเดอร์)
  const crossNodes = useMemo(() => {
    const curNodes = allDiagrams[cur]?.nodes ?? [];
    const here = new Set(curNodes.map((n) => n.id));
    // dedup ตาม node เป้าหมาย + เก็บทุก field ปลายเส้น (1 node อาจถูกชี้หลาย field)
    const byTarget = new Map<
      string,
      { label: string; tabId: string; tabName: string; handles: Set<string>; src?: CollectionNode }
    >();
    for (const e of edges) {
      // ปกติ source อยู่แท็บนี้เสมอ (เส้นเก็บใน diagram ต้นทาง) แต่ข้อมูลเก่าก่อนแก้ move_collection
      // อาจมีเส้นค้างที่ source อยู่แท็บอื่น — สร้าง stub ให้ทั้งสองข้าง ไม่งั้นเส้นหายเงียบ
      for (const end of [
        { id: e.target, handle: e.targetHandle, anchorId: e.source },
        { id: e.source, handle: e.sourceHandle, anchorId: e.target },
      ]) {
        if (here.has(end.id)) continue;
        const hit = byTarget.get(end.id);
        if (hit) {
          if (end.handle) hit.handles.add(end.handle);
          continue;
        }
        for (const t of tabs) {
          if (t.id === cur) continue;
          const tn = allDiagrams[t.id]?.nodes.find((n) => n.id === end.id);
          if (!tn) continue;
          byTarget.set(end.id, {
            label: tn.data.label,
            tabId: t.id,
            tabName: t.name,
            handles: new Set(end.handle ? [end.handle] : []),
            src: curNodes.find((n) => n.id === end.anchorId),
          });
          break;
        }
      }
    }
    return [...byTarget.entries()].map(
      ([targetId, v]) =>
        ({
          id: targetId,
          type: "crossref",
          position: {
            x: (v.src?.position.x ?? 0) + (v.src?.measured?.width ?? v.src?.width ?? 288) + 60,
            y: (v.src?.position.y ?? 0) + 20,
          },
          data: {
            label: v.label,
            description: v.tabName,
            fields: [],
            crossTabId: v.tabId,
            refHandles: [...v.handles],
          },
          draggable: false,
          selectable: false,
        }) as unknown as CollectionNode
    );
  }, [edges, tabs, cur, allDiagrams]);

  const flowNodes = useMemo(() => [...nodes, ...crossNodes], [nodes, crossNodes]);

  const compositeGroups = useMemo(() => {
    const nodeById = new Map<string, CollectionNode>();
    for (const diagram of Object.values(allDiagrams)) {
      for (const node of diagram.nodes) nodeById.set(node.id, node);
    }
    for (const node of nodes) nodeById.set(node.id, node);
    return compositeRenderGroups(
      [...nodeById.values()] as unknown as GenNode[],
      edges as unknown as (GenEdge & { id: string })[],
    ) as unknown as { id: string; edges: RelEdge[] }[];
  }, [allDiagrams, nodes, edges]);
  const compositeMembersById = useMemo(
    () => new Map(compositeGroups.map((group) => [group.id, group.edges.map((edge) => edge.id)])),
    [compositeGroups],
  );

  // double-click เส้น → วน reference/embed × cardinality 6 สถานะ
  const onEdgeDoubleClick = useCallback(
    (_: ReactMouseEvent, edge: RelEdge) => {
      const ids = new Set(compositeMembersById.get(edge.id) ?? [edge.id]);
      const rel = edge.data ?? {};
      const i = REL_CYCLE.findIndex(
        (cycle) => cycle.kind === (rel.kind ?? "reference") && cycle.cardinality === rel.cardinality,
      );
      const next = REL_CYCLE[(i + 1) % REL_CYCLE.length];
      const embed = next.kind === "embed";
      setEdges((current) =>
        current.map((edge) => {
          if (!ids.has(edge.id)) return edge;
          return {
            ...edge,
            data: { ...edge.data, ...next },
            animated: !embed,
            style: embed
              ? { stroke: "#64748b", strokeWidth: 1.5, strokeDasharray: "6 3", animationDirection: "reverse" }
              : { stroke: "#64748b", strokeWidth: 1.5, animationDirection: "reverse" },
          };
        }),
      );
    },
    [setEdges, compositeMembersById],
  );

  // label เส้น = ชื่อฟิลด์ต้นทาง (+ cardinality) + hover highlight — derive ล้วนตอน render
  // ถ้าหลาย field เชื่อมระหว่าง key ผสมคู่เดียวกัน ให้ซ่อนเส้นย่อยแล้ววาดเส้นสรุปเพียงเส้นเดียว
  // (ข้อมูลจริงยังเป็น field→field ครบทุกคู่ เพื่อให้ lint/codegen ใช้ mapping เดิมได้)
  const displayEdges = useMemo(() => {
    const nodeById = new Map<string, CollectionNode>();
    for (const d of Object.values(allDiagrams))
      for (const n of d.nodes) nodeById.set(n.id, n);
    for (const n of nodes) nodeById.set(n.id, n); // state ปัจจุบันใหม่กว่า allDiagrams

    const hiddenIds = new Set(compositeGroups.flatMap((group) => group.edges.map((edge) => edge.id)));
    const renderEdges: RelEdge[] = edges.map((edge) => {
      // edge.data มาจาก JSON import ได้ — whitelist เฉพาะ semantics; metadata composite เป็น render-only
      const data: DisplayRelData = {
        ...(edge.data?.kind && { kind: edge.data.kind }),
        ...(edge.data?.cardinality && { cardinality: edge.data.cardinality }),
        ...(hiddenIds.has(edge.id) && { hiddenComposite: true }),
      };
      return { ...edge, label: hiddenIds.has(edge.id) ? undefined : edge.label, data };
    });

    for (const composite of compositeGroups) {
      const group = composite.edges;
      const source = nodeById.get(group[0].source);
      const order = new Map(source?.data.fields.map((f, i) => [f.id, i]) ?? []);
      const members = [...group].sort((a, b) => {
        const af = a.sourceHandle?.replace(/-s(-[lr])?$/, "") ?? "";
        const bf = b.sourceHandle?.replace(/-s(-[lr])?$/, "") ?? "";
        return (order.get(af) ?? Number.MAX_SAFE_INTEGER) - (order.get(bf) ?? Number.MAX_SAFE_INTEGER);
      });
      const rep = members[0];
      const names = [...new Set(members.map((e) => {
        const fid = e.sourceHandle?.replace(/-s(-[lr])?$/, "");
        return source?.data.fields.find((f) => f.id === fid)?.name;
      }).filter((name): name is string => Boolean(name)))];
      const card = rep.data?.cardinality ? CARD_LABEL[rep.data.cardinality] : "";
      const name = names.join(" + ");
      renderEdges.push({
        ...rep,
        id: composite.id,
        label: name && card ? `${name} · ${card}` : name || card || undefined,
        data: {
          ...rep.data,
          compositeEdgeIds: members.map((e) => e.id),
        } as DisplayRelData,
      });
    }

    return renderEdges.map((e) => {
      // source ปกติอยู่แท็บนี้ — fallback หา stub เผื่อเส้นเก่าค้างผิด diagram (source อยู่แท็บอื่น)
      const src = nodes.find((n) => n.id === e.source) ?? crossNodes.find((n) => n.id === e.source);
      // auto-side: ทุก field มี handle ซ้าย/ขวา — เลือกข้างที่หันเข้าหากันตามตำแหน่ง node (ลาก node แล้วเส้นสลับข้างเอง ไม่อ้อมหลังการ์ด); ข้อมูลเก็บ canonical -s/-t เสมอ
      let sh = e.sourceHandle;
      let th = e.targetHandle;
      const tgt = nodes.find((n) => n.id === e.target) ?? crossNodes.find((n) => n.id === e.target);
      if (src && tgt && sh && th) {
        const scx = src.position.x + (src.measured?.width ?? 360) / 2;
        const tcx = tgt.position.x + (tgt.measured?.width ?? 360) / 2;
        const srcLeft = scx >= tcx;
        sh = `${sh.replace(/-[lr]$/, "")}-${srcLeft ? "l" : "r"}`;
        th = `${th.replace(/-[lr]$/, "")}-${srcLeft ? "r" : "l"}`;
      }
      const fid = e.sourceHandle?.replace(/-s(-[lr])?$/, "");
      const name = src?.data.fields.find((f) => f.id === fid)?.name ?? "";
      const card = e.data?.cardinality ? CARD_LABEL[e.data.cardinality] : "";
      const base0 = name && card ? `${name} · ${card}` : name || card || "";
      const labelText = base0; // เส้นข้าม tab มี stub node บอกชื่อ tab อยู่แล้ว ไม่ต้องต่อท้ายป้าย
      const displayData = e.data as DisplayRelData | undefined;
      const label = displayData?.hiddenComposite
        ? undefined
        : displayData?.compositeEdgeIds
          ? e.label
          : labelText || undefined;
      const el0 = e.label === label ? e : { ...e, label };
      const el =
        sh === e.sourceHandle && th === e.targetHandle
          ? el0
          : { ...el0, sourceHandle: sh, targetHandle: th };
      // edge เก่าที่ persist ไว้มี style/markerStart ของตัวเอง (ทำให้ defaultEdgeOptions ไม่ถูกใช้) — merge animationDirection + บังคับ marker orient ทุกเส้นตรงนี้ (วิ่ง/ชี้ แม่→ลูก)
      // เข้ารหัสความหมายลงเส้นเพิ่ม 2 มิติ (เดิมทุกเส้นสีเดียวหนาเท่ากัน ต่างกันแค่ลายเส้นประ
      // → บนภาพนิ่ง/ภาพที่ export ออกไปแยก reference/embed และ 1:1/1:N/N:N ไม่ได้เลย):
      // สี = ชนิด (reference เทา / embed ม่วง) · ความหนา = cardinality (1:1 บาง → N:N หนา)
      const kind = e.data?.kind ?? "reference";
      const cardKey = e.data?.cardinality ?? "1-n";
      const base = {
        animationDirection: "reverse" as const,
        ...e.style,
        stroke: kind === "embed" ? "#a78bfa" : "#64748b",
        strokeWidth: cardKey === "n-n" ? 2.5 : cardKey === "1-n" ? 2 : 1.5,
      };
      const marker: EdgeMarker = {
        type: MarkerType.ArrowClosed,
        color: "#38bdf8",
        width: 18,
        height: 18,
        ...(typeof e.markerStart === "object" ? e.markerStart : {}),
        orient: "auto-start-reverse",
      };
      // persisted edge มี type ของตัวเอง (ชนะ defaultEdgeOptions) — บังคับ "rel" ทุกเส้น ไม่งั้นเส้นเก่าไม่ได้ gap
      const elS = {
        ...el,
        type: "rel",
        style: base,
        markerStart: marker,
        selected: e.id === inspectedEdgeId || e.selected,
      };
      if (!hoveredId) return elS;
      return e.source === hoveredId || e.target === hoveredId
        ? { ...elS, style: { ...base, stroke: "#38bdf8", opacity: 1 } }
        : { ...elS, style: { ...base, opacity: 0.4 } };
    });
  }, [edges, nodes, crossNodes, hoveredId, allDiagrams, inspectedEdgeId, compositeGroups]);

  const inspectedMappings = useMemo(() => {
    if (!inspectedEdgeId) return [];
    const ids = compositeMembersById.get(inspectedEdgeId);
    if (!ids) return [];
    const nodeById = new Map<string, CollectionNode>();
    for (const diagram of Object.values(allDiagrams)) {
      for (const node of diagram.nodes) nodeById.set(node.id, node);
    }
    for (const node of nodes) nodeById.set(node.id, node);
    return ids.flatMap((edgeId) => {
      const edge = edges.find((candidate) => candidate.id === edgeId);
      if (!edge) return [];
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return [{
        id: edge.id,
        from: `${source?.data.label ?? edge.source}.${fieldByHandle(source, edge.sourceHandle)}`,
        to: `${target?.data.label ?? edge.target}.${fieldByHandle(target, edge.targetHandle)}`,
      }];
    });
  }, [inspectedEdgeId, compositeMembersById, edges, nodes, allDiagrams]);

  // React Flow รู้จักเส้นสรุปของ key ผสม แต่ state จริงรู้จักเฉพาะเส้น field→field:
  // เมื่อลบเส้นสรุป ให้แปลงเป็นการลบ mapping ทุกคู่ในกลุ่ม
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) => {
      const expanded: typeof changes = [];
      for (const change of changes) {
        if (change.type === "remove") {
          const ids = compositeMembersById.get(change.id) ?? [change.id];
          if (ids.length > 1 || ids[0] !== change.id) {
            for (const id of ids) expanded.push({ ...change, id });
            continue;
          }
        }
        expanded.push(change);
      }
      applyEdgeChanges(expanded);
    },
    [applyEdgeChanges, compositeMembersById]
  );

  // ตรวจโค้ดของแท็บปัจจุบันแยกจากผลรวมทั้ง project — modal codegen ต้องเตือนเฉพาะโค้ดที่กำลังแสดง
  // ห้ามใช้ crossNodes แทน — node เสมือนมี fields ว่าง ทำให้ field ปลายทาง resolve ไม่ได้
  const currentLintIssues = useMemo(
    () => lintModel(nodes as unknown as GenNode[], edges as unknown as GenEdge[], [
      ...(nodes as unknown as GenNode[]),
      ...Object.entries(allDiagrams)
        .filter(([id]) => id !== cur)
        .flatMap(([, d]) => d.nodes as unknown as GenNode[]),
    ]),
    [nodes, edges, allDiagrams, cur],
  );
  const lintIssues = useMemo<ProjectLintIssue[]>(() => {
    const diagrams = tabs.map((tab) => {
      const diagram = tab.id === cur ? { nodes, edges } : allDiagrams[tab.id] ?? { nodes: [], edges: [] };
      return {
        id: tab.id,
        name: tab.name,
        nodes: diagram.nodes as unknown as GenNode[],
        edges: diagram.edges as unknown as GenEdge[],
      };
    });
    return lintProject(diagrams);
  }, [tabs, cur, nodes, edges, allDiagrams]);

  // คีย์ลัด: Ctrl+D ทำซ้ำ, Ctrl+K ค้นหา, Ctrl+A เลือกทั้งหมด, Ctrl+C/V คัดลอก/วาง,
  // Ctrl+S กัน Save-Page dialog, Ctrl+Z/Y ย้อน/ทำซ้ำ, Esc ปิดค้นหา/modal/เมนูคลิกขวา
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        // ปิดให้ครบทุกชั้นที่เปิดค้างได้ — เดิมปิดแค่ค้นหา/สร้างโค้ด/เมนูคลิกขวา
        // ส่วน 🩺 ตรวจ กับ 🕘 ประวัติ กด Esc แล้วไม่ปิด (ไม่คงเส้นคงวาข้ามหน้าจอ)
        setQuery("");
        searchInput.current?.blur();
        setCodeOpen(false);
        setCtxMenu(null);
        setLintOpen(false);
        setHistOpen(false);
        setHelpOpen(false);
        setInspectedEdgeId(null);
        return;
      }
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      // Ctrl+S — คนกดติดมือเพื่อความมั่นใจ อย่าปล่อยให้เบราว์เซอร์เปิด Save-Page dialog
      if (k === "s") {
        ev.preventDefault();
        saveNow();
        notify("💾 บันทึกอัตโนมัติอยู่แล้ว — ทุกการแก้ไขถูกเก็บทันที (ไม่ต้องกด Ctrl+S)", 2500);
        return;
      }
      if (typing) {
        // Ctrl+Z/Y ในช่องพิมพ์ "บนการ์ด" = undo ของผังตามความเคยชิน Excel/Figma (blur ก่อนกันค่าค้าง)
        // ช่องอื่น (ค้นหา/ชื่อแท็บ/popup) คงเป็น native undo ของข้อความ
        if ((k === "z" || k === "y") && el instanceof HTMLElement && el.closest(".react-flow__node")) {
          el.blur();
        } else return;
      }
      if (k === "d") {
        const sel = nodes.find((n) => n.selected);
        if (!sel) return;
        ev.preventDefault();
        setNodes((ns) => [...ns, cloneCollection(sel, ns)]);
      } else if (k === "k") {
        ev.preventDefault();
        searchInput.current?.focus();
      } else if (k === "a") {
        // เลือกทุกคอลเลกชันในผัง (ไม่ใช่ select ข้อความทั้งหน้า)
        ev.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (k === "c") {
        const sel = nodes.find((n) => n.selected);
        if (sel) copyRef.current = sel; // เก็บ snapshot — ลบต้นฉบับแล้วยังวางได้
      } else if (k === "v") {
        if (!copyRef.current) return;
        ev.preventDefault();
        const src = copyRef.current;
        setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), cloneCollection(src, ns)]);
      } else if (k === "z") {
        ev.preventDefault();
        if (ev.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        ev.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, setNodes, undo, redo, saveNow, notify]);

  // ค้นหาจากชื่อคอลเลกชัน + ชื่อฟิลด์
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter(
      (n) =>
        n.data.label.toLowerCase().includes(q) ||
        fieldPathEntries(n.data.fields).some(({ path }) => path.toLowerCase().includes(q))
    );
  }, [nodes, query]);

  // ผลค้นหาจากแท็บอื่นด้วย (พร้อม badge ชื่อแท็บ) — ไม่งั้นผู้ใช้คิดว่า collection หาย ทั้งที่อยู่คนละแท็บ
  const crossSearchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { node: CollectionNode; tabId: string; tabName: string }[] = [];
    for (const t of tabs) {
      if (t.id === cur) continue;
      for (const n of allDiagrams[t.id]?.nodes ?? []) {
        if (
          n.data.label.toLowerCase().includes(q) ||
          fieldPathEntries(n.data.fields).some(({ path }) => path.toLowerCase().includes(q))
        )
          out.push({ node: n, tabId: t.id, tabName: t.name });
      }
    }
    return out;
  }, [query, tabs, cur, allDiagrams]);

  const focusNode = (nid: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nid })));
    setQuery("");
    fitView({ nodes: [{ id: nid }], duration: 300, maxZoom: 1.2 });
  };

  // กดผลค้นหาจากแท็บอื่น — สลับไปแท็บนั้นแล้วซูมหา node (รอ openDiagram โหลด state ก่อน)
  const focusCrossNode = (tabId: string, nid: string) => {
    setQuery("");
    switchTab(tabId);
    setTimeout(() => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nid })));
      fitView({ nodes: [{ id: nid }], duration: 300, maxZoom: 1.2 });
    }, 350);
  };

  // ตัวบอก toolbar ล้นจอ — จอแคบ (โน้ตบุ๊ก 1366/1280px) ปุ่มขวาสุดถูกซ่อนหลัง scroll เงียบๆ
  // ไม่มีสัญญาณอะไรเลย ผู้ใช้ไม่รู้ว่ามีปุ่มนำเข้า/ส่งออก/สำรองอยู่ — โชว์ » ไล่สีเมื่อยังมีของซ่อนขวา
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const check = () => setTbOverflow(el.scrollWidth - el.clientWidth - el.scrollLeft > 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  // ขนาดจริงของการ์ด — `n.measured` ใน controlled state ไม่ sync กลับจาก React Flow เสมอไป
  // (เจอ undefined ทั้งที่การ์ด render แล้ว) จึงอ่านจาก internal store ซึ่งเป็นแหล่งเดียวกับที่
  // React Flow ใช้วาดจริงก่อน แล้วค่อย fallback ค่าใน state / ค่า default
  const sizeOf = (n: CollectionNode) => {
    const m = getInternalNode(n.id)?.measured;
    return {
      w: m?.width ?? n.measured?.width ?? n.width ?? 288,
      h: m?.height ?? n.measured?.height ?? 240,
    };
  };

  const addCollection = (at?: { x: number; y: number }) => {
    const nid = uid();
    setNodes((ns) => {
      // ไม่ระบุตำแหน่ง (ปุ่ม toolbar) = กลางจอที่กำลังมองอยู่ แล้วเลื่อนลงจนไม่ทับใคร
      // (เดิมวางใต้การ์ดล่างสุดเสมอ → กด 5 ครั้งการ์ด 10/11 ใบหลุดจอ ใบใหม่มองไม่เห็นเลยสักพิกเซล)
      // ระบุตำแหน่ง (เมนูคลิกขวาบนพื้นที่ว่าง) = วางตรงที่คลิก
      let pos = at;
      if (!pos) {
        const r = document.querySelector(".react-flow")?.getBoundingClientRect();
        const c = screenToFlowPosition({
          x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 160,
          y: (r?.top ?? 0) + (r?.height ?? 600) / 3,
        });
        pos = { x: Math.round(c.x), y: Math.round(c.y) };
        for (let guard = 0; guard < 50; guard++) {
          const hit = ns.some(
            (n) => Math.abs(n.position.x - pos!.x) < 80 && Math.abs(n.position.y - pos!.y) < 60
          );
          if (!hit) break;
          pos = { x: pos.x + 40, y: pos.y + 60 };
        }
      }
      return [
        ...ns.map((n) => (n.selected ? { ...n, selected: false } : n)),
        {
          id: nid,
          type: "collection",
          position: pos,
          selected: true, // เลือกให้เลย — เห็นชัดว่าใบไหนคือใบที่เพิ่งสร้าง
          data: {
            label: `collection_${ns.length + 1}`,
            fields: [{ id: uid(), name: "_id", type: "ObjectId" as FieldType, required: true, description: "รหัสเอกสาร MongoDB" }],
          },
        },
      ];
    });
    // จอตามไปหาการ์ดใหม่ (เดิมไม่ pan/zoom เลย ผู้ใช้ไม่รู้ว่ากดติดไหม)
    setTimeout(() => void fitView({ nodes: [{ id: nid }], duration: 300, maxZoom: 1 }), 30);
    // ponytail: เข้าโหมดแก้ชื่อโดยยิง dblclick ที่ชื่อการ์ด — ถูกกว่าการเพิ่มธง autoEdit ลง
    // CollectionData ที่ต้องเขียน/ล้างผ่าน state แล้วติดไปกับไฟล์ที่บันทึกขึ้น server
    setTimeout(() => {
      document
        .querySelector<HTMLElement>(`.react-flow__node[data-id="${nid}"] .mm-card-head span`)
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, 380);
    notify("＋ เพิ่มคอลเลกชันแล้ว — พิมพ์ชื่อได้เลย", 2500);
  };

  // เพิ่มฟิลด์จากเมนูคลิกขวา (นอกตัวการ์ด) — โฟกัสช่องชื่อทันทีเหมือนปุ่ม ＋ เพิ่มฟิลด์ในการ์ด
  const addFieldTo = (nid: string) => {
    const fid = uid();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nid
          ? {
              ...n,
              data: {
                ...n.data,
                fields: [
                  ...n.data.fields,
                  { id: fid, name: `field_${n.data.fields.length + 1}`, type: "String" as FieldType, required: false },
                ],
              },
            }
          : n
      )
    );
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>(`input[data-fid="${fid}"]`);
      el?.focus();
      el?.select();
    }, 0);
  };

  // ย้าย collection ไปแท็บอื่นจาก UI (semantics เดียวกับ MCP move_collection):
  // node ออกจากแท็บนี้ + เส้นที่มันเป็น "ต้นทาง" ตามไปด้วย (invariant: เส้นข้าม tab เก็บใน diagram ต้นทาง)
  // เส้นที่ชี้ "มาหา" node นี้ยังอยู่แท็บนี้ → กลายเป็นเส้นข้าม tab (crossref stub) อัตโนมัติ
  const moveNodeToTab = (nid: string, tabId: string) => {
    const node = nodes.find((n) => n.id === nid);
    const tabName = tabs.find((t) => t.id === tabId)?.name ?? tabId;
    if (!node || tabId === cur) return;
    const dest = diagramsMap.current[tabId] ?? loadDiagram(tabId);
    if (dest.nodes.some((n) => n.data.label === node.data.label)) {
      window.alert(`แท็บ "${tabName}" มีคอลเลกชันชื่อ "${node.data.label}" อยู่แล้ว — ย้ายไม่ได้`);
      return;
    }
    const movingEdges = edges.filter((e) => e.source === nid);
    const newCur = persistedFlowDiagram(
      nodes.filter((n) => n.id !== nid),
      edges.filter((e) => e.source !== nid),
    );
    setNodes(newCur.nodes);
    setEdges(newCur.edges);
    const updated = persistedFlowDiagram(
      [...dest.nodes, node],
      [...dest.edges, ...movingEdges],
    );
    diagramsMap.current[tabId] = updated;
    // ต้องอัปเดต entry ของแท็บปัจจุบันด้วย — ไม่งั้น allDiagrams[cur] ยังมี node ที่ย้ายไปค้างอยู่
    // crossNodes จะคิดว่า node ยังอยู่แท็บนี้ (here.has = true) แล้วไม่สร้าง crossref stub เส้นหายเงียบ
    diagramsMap.current[cur] = newCur;
    trySave(dataKey(tabId), JSON.stringify(updated));
    trySave(dataKey(cur), JSON.stringify(newCur));
    setAllDiagrams({ ...diagramsMap.current }); // crossref stub คำนวณใหม่ทันที (autosave PUT ตามใน 400ms)
    notify(
      `➡ ย้าย "${node.data.label}" ไปแท็บ "${tabName}" แล้ว — เส้นเดิมกลายเป็นเส้นข้ามแท็บอัตโนมัติ`,
      4000
    );
  };

  // จัดผังอัตโนมัติ (hybrid):
  // 1) กลุ่มที่มีเส้นเชื่อม → ELK layered (master ซ้าย → transaction ขวา, ลดเส้นตัด)
  // 2) node เดี่ยวไม่มีเส้น → grid √n คอลัมน์ขวาสุด (ELK ล้วนกระจายเป็นหลายกม. — เคสนี้ grid ดีกว่า)
  const autoLayout = async () => {
    // เฉพาะเส้นที่ปลายทั้งสองอยู่ใน tab นี้ — เส้นข้าม tab ชี้ node ที่ไม่มีใน children ทำให้ ELK throw
    // (JsonImportException: Referenced shape does not exist) แล้วจัดผังล้มเงียบทั้งฟังก์ชัน
    const nodeIds = new Set(nodes.map((n) => n.id));
    const realEdges = edges.filter(
      (e) => e.source !== e.target && nodeIds.has(e.source) && nodeIds.has(e.target)
    );
    const linked = new Set<string>();
    realEdges.forEach((e) => {
      linked.add(e.source);
      linked.add(e.target);
    });
    const linkedNodes = nodes.filter((n) => linked.has(n.id));
    const isolatedNodes = nodes.filter((n) => !linked.has(n.id));

    const pos = new Map<string, { x: number; y: number }>();
    let gridX0 = 40;

    if (linkedNodes.length > 0) {
      const elk = new ELK();
      const res = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "LEFT",
          "elk.layered.spacing.nodeNodeBetweenLayers": "90",
          "elk.spacing.nodeNode": "45",
          "elk.spacing.componentComponent": "90",
        },
        children: linkedNodes.map((n) => {
          const s = sizeOf(n);
          return { id: n.id, width: s.w, height: s.h };
        }),
        edges: realEdges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
      });
      let maxX = 0;
      for (const c of res.children ?? []) {
        pos.set(c.id, { x: (c.x ?? 0) + 40, y: (c.y ?? 0) + 40 });
        maxX = Math.max(maxX, (c.x ?? 0) + (c.width ?? 0));
      }
      gridX0 = 40 + maxX + 120;
    }

    if (isolatedNodes.length > 0) {
      // แบ่งคอลัมน์ตาม √n แล้วเกาะกระจายด้วย bin-packing (ใส่คอลัมน์ที่เตี๋ยสุดทีละกล่อง — สมดุลแม้ node สูงต่างกัน)
      const gridCols = Math.ceil(Math.sqrt(isolatedNodes.length));
      const bins: { nodes: CollectionNode[]; h: number }[] = Array.from(
        { length: gridCols },
        () => ({ nodes: [], h: 0 })
      );
      for (const n of isolatedNodes) {
        const s = sizeOf(n);
        const shortest = bins.reduce((a, b) => (b.h < a.h ? b : a));
        shortest.nodes.push(n);
        shortest.h += s.h + 40;
      }
      let x = gridX0;
      for (const bin of bins) {
        if (!bin.nodes.length) continue;
        let y = 40;
        let w = 0;
        for (const n of bin.nodes) {
          const s = sizeOf(n);
          pos.set(n.id, { x, y });
          y += s.h + 40;
          w = Math.max(w, s.w);
        }
        x += w + 80;
      }
    }

    // นับการ์ดที่ขยับจริง — ผังที่จัดไว้ดีอยู่แล้วจะไม่มีอะไรเปลี่ยนบนจอเลย ต้องบอกว่าทำงานแล้ว
    const moved = nodes.filter((n) => {
      const p = pos.get(n.id);
      return p && (Math.abs(p.x - n.position.x) > 1 || Math.abs(p.y - n.position.y) > 1);
    }).length;
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    setTimeout(() => fitView({ padding: 0.1, duration: 400 }), 60);
    notify(
      moved > 0
        ? `▦ จัดผังแล้ว — ย้าย ${moved} คอลเลกชัน`
        : "▦ ผังอยู่ในตำแหน่งที่เหมาะสมอยู่แล้ว (ไม่มีการย้าย)",
      2500
    );
  };

  const downloadJson = (obj: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportJson = () => {
    const name = tabs.find((t) => t.id === cur)?.name ?? "diagram";
    const persisted = persistedFlowDiagram(nodes, edges);
    downloadJson(
      { app: "mongomodel", version: 1, name, ...persisted },
      `${name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`
    );
  };

  // สำรองทุกแท็บเป็นไฟล์เดียว
  const backupAll = () => {
    saveNow();
    const diagrams = tabs.map((t) => {
      const d = t.id === cur ? { nodes, edges } : diagramsMap.current[t.id] ?? loadDiagram(t.id);
      return { name: t.name, ...persistedFlowDiagram(d.nodes, d.edges) };
    });
    downloadJson(
      { app: "mongomodel", version: 2, diagrams },
      `mongomodel-backup-${new Date().toISOString().slice(0, 10)}.json`
    );
  };

  // นำเข้า = เพิ่มเป็นแท็บใหม่ (ไม่ทับงานเดิม)
  const importJson = (file: File) =>
    readFile(file, (list) => {
      saveNow();
      let lastId = "";
      for (const d of list) {
        const id = uid();
        const persisted = persistedFlowDiagram(d.nodes, d.edges);
        trySave(dataKey(id), JSON.stringify(persisted));
        diagramsMap.current[id] = persisted;
        setTabs((ts) => [...ts, { id, name: d.name }]);
        lastId = id;
      }
      openDiagram(lastId);
    });

  // เนื้อหาศูนย์ส่งออกโค้ด
  const codeText = useMemo(() => {
    if (!codeOpen) return "";
    const gn: GenNode[] = nodes.map((n) => ({ id: n.id, data: n.data }));
    // node ทุก diagram ในโปรเจกต์ — ให้ codegen resolve ref ของเส้นที่ข้าม tab ได้ (reactive state ไม่อ่าน ref ระหว่าง render)
    const allGn: GenNode[] = [
      ...gn,
      ...Object.entries(allDiagrams)
        .filter(([id]) => id !== cur)
        .flatMap(([, d]) => d.nodes.map((n) => ({ id: n.id, data: n.data }))),
    ];
    const ge: GenEdge[] = edges.map((e) => ({
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      data: e.data,
    }));
    return codeTab === "mongosh"
      ? toMongosh(gn, ge, allGn)
      : codeTab === "Go"
        ? toGo(gn, ge)
        : codeTab === "Mongoose"
        ? toMongoose(gn, ge, allGn)
        : codeTab === "TypeScript"
          ? toTypeScript(gn, ge, allGn)
          : codeTab === "Markdown"
            ? toMarkdown(gn, ge, allGn)
            : codeTab === "Wiki"
              ? Object.entries(toWiki(gn, ge, project, allGn))
                  .map(([f, c]) => `### 📄 ${f}\n\n${c}`)
                  .join("\n\n---\n\n")
              : codeTab === "ตัวอย่าง"
                ? gn.map((n) => `// ${n.data.label}\n` + toSampleDoc(n)).join("\n\n")
                : JSON.stringify(persistedFlowDiagram(nodes, edges), null, 2);
  }, [codeOpen, codeTab, nodes, edges, project, allDiagrams, cur]);

  // แผง wiki กินจอไปครึ่ง — toolbar เหลือมองเห็น ~31% ปุ่มหลัก 10 ตัวหลุดออกนอกกรอบ scroll
  // โหมดย่อ = เหลือไอคอนล้วน (ปุ่มยังครบ ไม่ต้องเลื่อนหา)
  const compact = wikiOpen;

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      {/* ข้ามไปที่ผังเลย — คีย์บอร์ดล้วนไม่ต้อง Tab ผ่านปุ่ม 13 ตัวทุกครั้งที่โหลดหน้า */}
      <a
        href="#mm-canvas"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[90] focus:rounded-lg focus:bg-sky-600 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        ข้ามไปที่ผัง
      </a>
      {/* แถบเครื่องมือ */}
      <header className="mm-bar relative z-30 flex items-center gap-3 px-4 py-2.5">
        <button
          className="mm-btn border-transparent bg-transparent px-2"
          title="กลับไปหน้าเลือกโปรเจกต์"
          onClick={onExit}
        >
          ←
        </button>
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.5)]" />
        {/* โหมดย่อ (เปิด wiki ข้าง canvas) — ยอมสละชื่อแอป/ชิปโปรเจกต์ คืนที่ให้ปุ่มเครื่องมือ
            (ชื่อโปรเจกต์ยังอยู่บนหัวแผง wiki ที่เปิดอยู่ข้าง ๆ) */}
        <h1
          className={`shrink-0 text-[15px] font-semibold tracking-tight text-slate-50 ${compact ? "hidden" : "hidden sm:block"}`}
        >
          MongoModel
        </h1>
        <span
          className={`max-w-48 shrink-0 truncate rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-300 ${compact ? "hidden" : "hidden xl:block"}`}
        >
          {project}
        </span>
        <span className="hidden shrink-0 whitespace-nowrap text-xs text-slate-500 2xl:block">
          ออกแบบโครงสร้างข้อมูล MongoDB
        </span>
        <nav aria-label="แถบเครื่องมือ" className="relative ml-auto flex min-w-0 items-center gap-1">
        <div ref={toolbarRef} className="mm-toolbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
          {/* ค้นหา + ซูมไปหา — กล่องผลย้ายออกไปนอก .mm-toolbar แล้ว (overflow-x:auto ทำให้แกนตั้ง
              compute เป็น auto ตามสเปค → dropdown เคยถูกตัดเหลือ 72%) */}
          <input
            ref={searchInput}
            className={`mm-input shrink-0 ${compact ? "w-28" : "w-28 lg:w-44"}`}
            placeholder="🔍 ค้นหา (Ctrl+K)"
            aria-label="ค้นหาคอลเลกชันหรือฟิลด์"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {/* งานหลักสุดต้องมาก่อน undo บนจอแคบ เพื่อให้ผู้เริ่มต้นยังเห็นปุ่มสร้าง collection */}
          <button
            className="mm-btn mm-btn-accent"
            title="เพิ่มคอลเลกชันใหม่ลงในผัง"
            onClick={() => addCollection()}
          >
            ＋ <span className={compact ? "hidden" : "hidden xl:inline"}>เพิ่มคอลเลกชัน</span>
          </button>
          <button
            className="mm-btn px-2.5"
            title="ย้อนกลับ (Ctrl+Z)"
            disabled={!histSizes.past && !dirty}
            onClick={undo}
          >
            ↶
          </button>
          <button
            className="mm-btn px-2.5"
            title="ทำซ้ำ (Ctrl+Y / Ctrl+Shift+Z)"
            disabled={!histSizes.future}
            onClick={redo}
          >
            ↷
          </button>
          <button
            className="mm-btn"
            title="จัดเรียง node อัตโนมัติ ไม่ให้ทับกัน"
            onClick={() => void autoLayout()}
          >
            ▦ <span className={compact ? "hidden" : "hidden xl:inline"}>จัดผัง</span>
          </button>
          <button
            className="mm-btn mm-btn-primary"
            title="สร้างโค้ด mongosh / Go / Mongoose / TypeScript / Wiki จากผังนี้"
            onClick={() => setCodeOpen(true)}
          >
            ⚙️ <span className={compact ? "hidden" : "hidden xl:inline"}>สร้างโค้ด</span>
          </button>
          <button
            className={`mm-btn ${lintIssues.length ? "border-amber-500/40 text-amber-300" : ""}`}
            title="ตรวจโมเดลทุกแท็บในโปรเจกต์ (ฟิลด์เงิน, index, unique, FK, array)"
            onClick={() => setLintOpen(true)}
          >
            🩺 <span className={compact ? "hidden" : "hidden xl:inline"}>ตรวจ</span>
            {lintIssues.length > 0 ? ` (${lintIssues.length})` : ""}
          </button>
          <button
            className={`mm-btn ${wikiOpen ? "mm-btn-on" : ""}`}
            title="เปิด/ปิด wiki แบบ Obsidian ข้าง canvas (หน้าเดียวกัน)"
            onClick={() => onShowWiki(project)}
          >
            📖 <span className={compact ? "hidden" : "hidden xl:inline"}>Wiki</span>
          </button>
        </div>
        {/* toolbar ล้น — ปุ่มเลื่อนเป็น "พี่น้อง" ของแถบ ไม่ใช่ overlay absolute ทับปุ่มขวาสุด
            (ของเดิมโปร่งใสแต่กินคลิก: ที่ 1440px ปุ่ม 🕘 กดโดนแค่ 40% ส่วนปุ่มธีมกดไม่โดนเลย) */}
        {tbOverflow && (
          <button
            className="mm-btn shrink-0 px-2"
            title="ยังมีปุ่มซ่อนอยู่ทางขวา — กดเพื่อเลื่อนดู"
            onClick={() => toolbarRef.current?.scrollBy({ left: 220, behavior: "smooth" })}
          >
            »
          </button>
        )}
        {/* งานไฟล์/ประวัติใช้ไม่บ่อย — รวมไว้ในเมนูเดียวให้ toolbar หลักอ่านเป็นลำดับงาน */}
        <details
          className="relative shrink-0"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.removeAttribute("open");
          }}
        >
          <summary className="mm-btn list-none px-2.5" title="นำเข้า ส่งออก สำรอง และประวัติ" aria-label="งานเพิ่มเติม">
            •••
          </summary>
          <div className="mm-panel absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden p-1 text-xs">
            <button
              className="block w-full rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                fileInput.current?.click();
              }}
            >
              📥 นำเข้า JSON เป็นแท็บใหม่
            </button>
            <button
              className="block w-full rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                exportJson();
              }}
            >
              📤 ส่งออกโปรเจกต์นี้
            </button>
            <button
              className="block w-full rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                backupAll();
              }}
            >
              💾 สำรองทุกโปรเจกต์
            </button>
            <button
              className="mt-1 block w-full border-t border-white/10 px-3 py-2 text-left text-slate-300 hover:bg-slate-800 hover:text-slate-100"
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                setHistOpen(true);
                setRevisions(null);
                void fetch("/api/revisions")
                  .then((r) => (r.ok ? r.json() : Promise.reject()))
                  .then((j) => setRevisions(j.revisions ?? []))
                  .catch(() => setRevisions([]));
              }}
            >
              🕘 ประวัติและกู้คืน
            </button>
          </div>
        </details>
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
        {/* กล่องผลค้นหา — อยู่ระดับนอกแถบที่ scroll ได้ จึงไม่ถูก clip */}
        {query.trim() !== "" && (
          <div className="mm-panel absolute left-0 top-full z-50 mt-1.5 max-h-64 w-64 overflow-auto">
            {searchResults.map((n) => (
              <button
                key={n.id}
                className="block w-full px-3 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800"
                onClick={() => focusNode(n.id)}
              >
                <span className="font-medium">{n.data.label}</span>
                <span className="ml-2 text-xs text-slate-500">{n.data.fields.length} ฟิลด์</span>
              </button>
            ))}
            {/* ผลจากแท็บอื่น — badge บอกชื่อแท็บ กดแล้วสลับแท็บ+ซูมหา */}
            {crossSearchResults.map(({ node: n, tabId, tabName }) => (
              <button
                key={`${tabId}:${n.id}`}
                className="block w-full px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-slate-800"
                title={`อยู่ในแท็บ "${tabName}" — กดเพื่อสลับไป`}
                onClick={() => focusCrossNode(tabId, n.id)}
              >
                <span className="font-medium">{n.data.label}</span>
                <span className="ml-2 rounded px-1.5 text-[10px] font-medium text-amber-300">
                  แท็บ {tabName}
                </span>
              </button>
            ))}
            {searchResults.length === 0 && crossSearchResults.length === 0 && (
              <div className="px-3 py-1.5 text-sm text-slate-500">
                ไม่พบ “{query.trim()}” — ลองชื่อคอลเลกชันหรือชื่อฟิลด์ (ค้นทุกแท็บให้อยู่แล้ว)
              </div>
            )}
          </div>
        )}
        </nav>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label="เลือกไฟล์ JSON ที่จะนำเข้า"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = "";
          }}
        />
      </header>

      {/* toast — ลอยทับมุมขวาล่าง ไม่แทรกในสายเลย์เอาต์ (เดิมเป็น element ปกติ: โผล่ทีไร canvas
          ทั้งผืนกระโดดลง 28.8px แล้วเด้งกลับตอนหาย = ทุกครั้งที่ AI แก้ผ่าน MCP)
          role=status + aria-live ให้ screen reader ได้ยินด้วย (ทั้งแอปเดิมไม่มี aria-live เลย) */}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-md flex-col items-end gap-2"
        role="status"
        aria-live="polite"
      >
        {aiNotice && (
          <div className="mm-toast pointer-events-auto flex items-start gap-2 rounded-xl border border-emerald-900 bg-emerald-950 px-3 py-2 text-xs text-emerald-300 shadow-[var(--elev-2)]">
            <span className="flex-1">{aiNotice}</span>
            <button className="mm-ico text-emerald-300 hover:text-emerald-100" title="ปิด" onClick={() => setAiNotice("")}>
              ✕
            </button>
          </div>
        )}
        {sweepNotice && (
          <div className="mm-toast pointer-events-auto flex items-start gap-2 rounded-xl border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300 shadow-[var(--elev-2)]">
            <span className="flex-1">🧹 {sweepNotice}</span>
            <button className="mm-ico text-amber-300 hover:text-amber-100" title="ปิด" onClick={() => setSweepNotice("")}>
              ✕
            </button>
          </div>
        )}
      </div>

      {/* แถบเตือน — localStorage เต็ม */}
      {saveError && (
        <div className="border-b border-red-900 bg-red-950 px-4 py-1.5 text-xs text-red-300">
          ⚠ บันทึกไม่สำเร็จ (พื้นที่เต็ม) — กด 💾 สำรองทั้งหมด แล้วลบ diagram ที่ไม่ใช้
        </div>
      )}
      {/* แถบเตือน — แก้ชนกันหลายแท็บเบราว์เซอร์ */}
      {externalEdit && (
        <div className="flex items-center gap-2 border-b border-yellow-900 bg-yellow-950 px-4 py-1.5 text-xs text-yellow-300">
          <span className="flex-1">
            ⚠ การแก้ล่าสุด<b>ยังไม่ถูกบันทึกขึ้น server</b> — มีการแก้จาก AI (MCP) หรือแท็บอื่นชนกัน
            ให้เลือกทางใดทางหนึ่งก่อนแก้ต่อ
          </span>
          {/* การแก้ที่ชน (409) ไม่ถูก auto ทับ — ผู้ใช้ต้องเลือกเองว่าเอาของฝั่งไหน */}
          <button
            className="shrink-0 rounded border border-yellow-700 px-2 py-0.5 hover:text-yellow-100"
            title="โหลดข้อมูลล่าสุดจาก server มาแทน (การแก้ในเครื่องที่ชนกันจะถูกทิ้ง)"
            onClick={() => {
              conflict.current = false;
              setExternalEdit(false);
              void bootstrap();
            }}
          >
            🔄 ใช้ของ server (ทิ้งของในเครื่อง)
          </button>
          <button
            className="shrink-0 rounded border border-yellow-700 px-2 py-0.5 hover:text-yellow-100"
            title="บันทึกของในเครื่องทับ server (การแก้จาก AI/แท็บอื่นที่ชนกันจะถูกทิ้ง)"
            onClick={() => {
              saveNow();
              pushToServer(JSON.stringify({ tabs, cur, diagrams: diagramsMap.current }), true);
            }}
          >
            💾 ใช้ของในเครื่อง (ทับ server)
          </button>
          <button
            className="shrink-0 hover:text-yellow-100"
            title="ปิดแถบเตือน (ยังไม่บันทึกจนกว่าจะเลือก)"
            onClick={() => setExternalEdit(false)}
          >
            ✕
          </button>
        </div>
      )}

      {/* แท็บ diagram — save/load ในเครื่อง */}
      <div className="mm-bar flex shrink-0 items-end gap-1 overflow-x-auto px-3 pt-2" role="tablist" aria-label="แท็บผัง (diagram)">
        {tabs.map((t, ti) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === cur}
            className={`mm-tab group flex shrink-0 cursor-pointer items-center gap-1.5 px-3.5 py-2 text-sm ${t.id === cur ? "mm-tab-active" : ""}`}
            onClick={() => switchTab(t.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (tabDrag.current !== null) reorderTab(tabDrag.current, ti);
              tabDrag.current = null;
            }}
          >
            <span
              className="cursor-grab select-none text-xs opacity-60 hover:opacity-100 active:cursor-grabbing"
              title="ลากเพื่อจัดลำดับแท็บ"
              draggable
              onDragStart={(e) => {
                tabDrag.current = ti;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(ti));
              }}
              onDragEnd={() => {
                tabDrag.current = null;
              }}
            >
              ▦
            </span>
            {t.id === cur ? (
              <input
                className="w-32 bg-transparent outline-none"
                aria-label="ชื่อผัง (diagram)"
                value={t.name}
                onChange={(e) => renameTab(t.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="max-w-32 truncate">{t.name}</span>
            )}
            <button
              className="text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-400"
              title="ลบ diagram นี้"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(t.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="mb-1 ml-1 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          title="สร้าง diagram ใหม่"
          onClick={newTab}
        >
          ＋
        </button>
      </div>

      {/* กระดานออกแบบ */}
      <main id="mm-canvas" className="relative flex-1" aria-label="ผังโครงสร้างข้อมูล">
        <ReactFlow
          colorMode={theme}
          nodes={flowNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onEdgeClick={(_, edge) => {
            setInspectedEdgeId(compositeMembersById.has(edge.id) ? edge.id : null);
          }}
          onNodeClick={(_, n) => {
            // stub ปลายทางเส้นข้าม tab — กดแล้วข้ามไป tab นั้น
            if ((n.type as string) === "crossref" && n.data.crossTabId) openDiagram(n.data.crossTabId);
          }}
          // เมนูคลิกขวาของแอป (การ์ด/เส้น/พื้นที่ว่าง) — แทนเมนูเบราว์เซอร์เปล่าๆ
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            if ((n.type as string) === "crossref") return; // stub ใช้คลิกซ้ายข้ามแท็บอยู่แล้ว
            setCtxMenu({ x: e.clientX, y: e.clientY, kind: "node", id: n.id });
          }}
          onEdgeContextMenu={(e, ed) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, kind: "edge", id: ed.id });
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            const me = e as ReactMouseEvent;
            setCtxMenu({ x: me.clientX, y: me.clientY, kind: "pane" });
          }}
          onPaneClick={() => {
            setCtxMenu(null);
            setInspectedEdgeId(null);
          }}
          // จำ zoom/pan ล่าสุดของแท็บนี้ — เปิดกลับมาอยู่ที่เดิม (session-6)
          onMoveEnd={(_, vp) => {
            if (cur)
              try {
                localStorage.setItem(vpKey(cur), JSON.stringify(vp));
              } catch {}
          }}
          onBeforeDelete={async ({ nodes: del }) => {
            // ลบทั้ง collection ต้อง confirm เสมอ (✕ = ลบถาวร ไม่ใช่ปิด — กระทบฟิลด์ทั้งหมด + เส้นที่เชื่อม)
            // ครอบทุกทาง: ปุ่ม ✕ บนการ์ด, Delete key, เมนูคลิกขวา · ลบเฉพาะเส้น (del ว่าง) ไม่ต้องถาม
            if (del.length === 0) return true;
            return askConfirm({
              title:
                del.length === 1
                  ? `ลบคอลเลกชัน “${del[0].data.label}” ?`
                  : `ลบคอลเลกชัน ${del.length} ตัวที่เลือก?`,
              description: "เส้นที่เชื่อมจะถูกลบด้วย — ย้อนได้ด้วย Ctrl+Z",
              confirmLabel: "ลบคอลเลกชัน",
              destructive: true,
            });
          }}
          onNodeMouseEnter={(_, n) => setHoveredId(n.id)}
          onNodeMouseLeave={() => setHoveredId(null)}
          deleteKeyCode={["Delete", "Backspace"]}
          snapToGrid
          snapGrid={[20, 20]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          zoomOnScroll={false}
          panOnScroll
          // 48 (ค่าเดิม) กว้างกว่าระยะระหว่าง handle เอง — source กับ target ของ field เดียวกันห่างแค่ 14px
          // และแถวถัดไปห่าง ~39px จึงคว้า handle ตัวอื่นแทนตัวที่กด (เส้นออกผิดจุด) 10 = แคบกว่าครึ่งของ 14
          connectionRadius={10}
          // การ์ด collection สูงได้ไม่จำกัด (field เยอะ+ซ้อนลึก = สูงหลายพัน px) — default minZoom 0.5
          // ทำให้ Fit View/Zoom Out ติดเพดาน มองไม่เห็นทั้งผัง (กดแล้วจอไม่ขยับเลย)
          minZoom={0.05}
          defaultEdgeOptions={{
            type: "rel",
            animated: true,
            // dash animation วิ่งตาม path (ลูก→แม่) ผิดทิศความหมาย — inline animationDirection reverse ให้วิ่งแม่→ลูก (inline ชนะ animation shorthand จาก stylesheet เสมอ ไม่พึ่ง globals.css; onEdgeDoubleClick ต้องใส่ค่านี้ทุก style ด้วย)
            style: { stroke: "#64748b", strokeWidth: 1.5, animationDirection: "reverse" },
            // ทิศลูกศร: แม่(master/key=target) → ลูก(FK=source) — markerStart อยู่ปลายฝั่งลูก + orient auto-start-reverse ให้หัวลูกศรชี้เข้าหาลูก (default auto จะชี้ออก = กลับทิศ)
            markerStart: { type: MarkerType.ArrowClosed, color: "#38bdf8", width: 20, height: 20, orient: "auto-start-reverse" },
          }}
          // ไม่ใส่ prop fitView — openDiagram จัดมุมมองเองทุกครั้ง (viewport ที่จำไว้ หรือ fit view)
          // ถ้าใส่ไว้ initial fit จะยิงทีหลังแล้วทับ viewport ที่เพิ่ง restore
        >
          {/* สี grid/minimap ต้องพลิกตามธีมด้วย — ค่า hex ตายตัวเดิมทำให้โหมดสว่างได้ลายจุดเข้ม
              และ minimap กลายเป็นกล่องดำทึบทับ canvas */}
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            color={theme === "light" ? "#cbd5e1" : "#1e293b"}
          />
          <Controls />
          {inspectedMappings.length > 0 && (
            <Panel position="top-right">
              <aside className="mm-panel w-80 overflow-hidden text-xs" aria-label="mapping ของ key ผสม">
                <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
                  <span className="font-semibold text-sky-300">⛓ mapping key ผสม ({inspectedMappings.length} คู่)</span>
                  <button className="mm-ico nodrag ml-auto text-slate-400 hover:text-slate-100" title="ปิด" onClick={() => setInspectedEdgeId(null)}>✕</button>
                </div>
                <div className="max-h-64 overflow-auto p-2">
                  {inspectedMappings.map((mapping) => (
                    <div key={mapping.id} className="mb-1 rounded bg-slate-950/40 px-2 py-1 text-slate-300 last:mb-0">
                      <span className="text-sky-300">{mapping.from}</span>
                      <span className="mx-1.5 text-slate-500">→</span>
                      <span className="text-amber-300">{mapping.to}</span>
                    </div>
                  ))}
                </div>
              </aside>
            </Panel>
          )}
          {/* ซ่อน minimap เมื่อผังยังว่าง (ไม่มีอะไรให้ย่อ) หรือเมื่อเปิด wiki ข้าง canvas (ที่แคบ) */}
          {nodes.length > 0 && !wikiOpen && (
            <MiniMap
              style={{ width: 150, height: 100 }}
              nodeColor={theme === "light" ? "#93c5fd" : "#1e40af"}
              maskColor={theme === "light" ? "rgba(15,23,42,0.12)" : "rgba(2,6,23,0.75)"}
              pannable
              zoomable
            />
          )}
          {/* แผงรายชื่อ collection ด้านซ้าย — กดแล้วกระโดดไปหา node เลย */}
          <Panel position="top-left">
            <aside className="mm-panel w-60 overflow-hidden" aria-label="รายชื่อคอลเลกชัน">
              <button
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-semibold text-slate-300 hover:text-slate-100"
                title="พับ/ขยายรายชื่อ collection"
                onClick={() => setNavOpen((v) => !v)}
              >
                <span className={`inline-block text-[10px] transition-transform ${navOpen ? "rotate-90" : ""}`}>
                  ▶
                </span>
                คอลเลกชัน ({nodes.length})
              </button>
              {navOpen && (
                <>
                  {nodes.length > 6 && (
                    <div className="px-2 pb-1">
                      <input
                        className="mm-input w-full px-2 py-1 text-[11px]"
                        placeholder="กรองชื่อ/คำอธิบาย…"
                        aria-label="กรองรายชื่อคอลเลกชัน"
                        value={navQuery}
                        onChange={(e) => setNavQuery(e.target.value)}
                      />
                    </div>
                  )}
                  <div className="max-h-[45vh] overflow-y-auto p-1">
                    {nodes
                      .filter((n) => {
                        const q = navQuery.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          n.data.label.toLowerCase().includes(q) ||
                          (n.data.description ?? "").toLowerCase().includes(q)
                        );
                      })
                      .map((n) => (
                        <button
                          key={n.id}
                          className={`block w-full rounded px-2 py-1 text-left transition-colors ${
                            n.selected
                              ? "bg-sky-500/15 text-sky-300"
                              : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                          }`}
                          title={`${n.data.label} (${n.data.fields.length} ฟิลด์) — กดเพื่อไปหา`}
                          onClick={() => focusNode(n.id)}
                        >
                          {/* แผงนี้คือสิ่งเดียวที่ยังอ่านออกตอนเปิดผังใหญ่ — 9px เล็กเกินสำหรับไทย
                              และ truncate บรรทัดเดียวตัดคำอธิบายหายไปกว่าครึ่ง */}
                          <div className="truncate text-[11px]">
                            {n.data.label}
                            {/* วงเล็บกันอ่านติดกับชื่อ ("สินค้า3" ดูเหมือน rename เป็นสินค้า3) */}
                            <span className="ml-1.5 text-[10px] text-slate-400">({n.data.fields.length} ฟิลด์)</span>
                          </div>
                          {n.data.description && (
                            <div className="line-clamp-2 text-[11px] text-slate-400" title={n.data.description}>
                              {n.data.description}
                            </div>
                          )}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </aside>
          </Panel>
          {/* ปุ่มคู่มือ — ย้ายมาซ้ายล่าง (เดิมมุมขวาล่างทับมุม minimap พอดี) */}
          <Panel position="bottom-left">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-800 bg-slate-900/90 text-xs text-slate-300 shadow hover:text-slate-100"
              title="คู่มือ / คีย์ลัด / ความหมายสัญลักษณ์"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((v) => !v)}
            >
              ?
            </button>
          </Panel>
          {helpOpen && (
            <Panel
              position="bottom-left"
              className="mb-9 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs leading-relaxed text-slate-300 shadow-2xl"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-semibold text-slate-100">คู่มือ / คีย์ลัด</span>
                <button
                  className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                  title="ปิดคู่มือ"
                  onClick={() => setHelpOpen(false)}
                >
                  ✕
                </button>
              </div>
              <ul className="space-y-1">
                <li>• ลากจุดขวาของฟิลด์ → เชื่อมความสัมพันธ์</li>
                <li>• คลิกขวา (การ์ด/เส้น/พื้นว่าง) = เมนูลัด</li>
                <li>• ลากพื้นว่าง = กรอบเลือกหลายอัน</li>
                <li>• เมาส์กลาง/ขวาลาก = เลื่อนจอ</li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Ctrl</kbd>+ลาก /{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl</kbd>+wheel = ซูม
                </li>
                <li>• wheel = เลื่อนจอ · Shift+wheel = เลื่อนแนวนอน</li>
                <li>• ดับเบิลคลิกเส้น = เปลี่ยนชนิด/ความสัมพันธ์</li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Ctrl+D</kbd> ทำซ้ำ ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl+C/V</kbd> คัดลอก/วาง ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl+A</kbd> เลือกทั้งหมด
                </li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Ctrl+K</kbd> ค้นหา ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl+Z</kbd> ย้อน ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Delete</kbd> ลบ
                </li>
                {/* คำสั่งพื้นฐานที่ผู้ใช้ต้องเดาเองมาตลอด */}
                <li>• ดับเบิลคลิกชื่อการ์ด/ชื่อฟิลด์ = แก้ชื่อ · Enter = ไปฟิลด์ถัดไป/สร้างใหม่</li>
                <li>• 🕘 ประวัติ = กู้คืนย้อนหลังทั้ง workspace</li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Esc</kbd> = ปิดหน้าต่าง/ยกเลิกการแก้ชื่อ
                </li>
              </ul>
              {/* legend — ความหมายของสัญลักษณ์เดิมอยู่ใน tooltip อย่างเดียว ต้อง hover ทีละตัวถึงจะรู้ */}
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="mb-1 font-semibold text-slate-100">สัญลักษณ์</div>
                <ul className="space-y-0.5">
                  <li>🔑 primary key / business key ที่ collection อื่นอ้างถึง</li>
                  <li>⛓ สมาชิก key ผสม (หลายฟิลด์รวมเป็น key เดียว)</li>
                  <li>* จำเป็นต้องมี · U unique index · ⊂ array มีขอบเขตแล้ว</li>
                  <li>◇ enum / ค่าเริ่มต้น · 💬 คำอธิบายไทย (เหลือง = ยังไม่มี)</li>
                  <li>⧉ ทำซ้ำ · ✕ ลบ · ⠿ ลากจัดลำดับ</li>
                  <li>← N จำนวน collection ในแท็บนี้ที่อ้างถึง key นั้น</li>
                  <li>⚠ จุดที่ควรทบทวน (ดูรายละเอียดที่ 🩺 ตรวจ)</li>
                  <li>เส้นทึบเทา = reference · เส้นประม่วง = embed · ยิ่งหนา = ยิ่งเป็น N:N</li>
                  <li>การ์ดเส้นประเหลือง = ปลายทางอยู่คนละแท็บ (กดเพื่อข้ามไป)</li>
                  <li>ลากเส้นจากจุดข้างการ์ดมาที่แถบ 🔑 key เพื่อเชื่อมความสัมพันธ์</li>
                </ul>
              </div>
            </Panel>
          )}
        </ReactFlow>

        {/* หน้าว่าง — เดิมเป็นพื้นเปล่า 81% ของจอ ไม่มีคำแนะนำอะไรเลย */}
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <div className="text-4xl opacity-60">▦</div>
            <div className="text-base font-semibold text-slate-200">ยังไม่มีคอลเลกชันในแท็บนี้</div>
            <div className="max-w-md text-xs leading-relaxed text-slate-400">
              เริ่มจากกดปุ่มด้านล่าง (หรือ ＋ เพิ่มคอลเลกชัน บนแถบเครื่องมือ · คลิกขวาบนพื้นที่ว่างก็ได้)
              — หรือให้ AI สร้างให้ผ่าน MCP ที่ <code className="text-slate-300">http://localhost:3100/mcp</code>
            </div>
            <button className="mm-btn mm-btn-accent pointer-events-auto" onClick={() => addCollection()}>
              ＋ เพิ่มคอลเลกชันแรก
            </button>
          </div>
        )}
      </main>

      {/* ศูนย์ส่งออกโค้ด */}
      {lintOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setLintOpen(false)}
        >
          <div
            className="mm-modal mm-panel flex h-full max-h-[70vh] w-full max-w-3xl flex-col overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label="ตรวจโมเดล"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-semibold text-slate-200">🩺 ตรวจโมเดล</span>
              <span className="text-xs text-slate-500">
                {lintIssues.length === 0
                  ? "ไม่พบปัญหา"
                  : `${lintIssues.filter((i) => i.level === "error").length} ต้องแก้ · ${lintIssues.filter((i) => i.level === "warn").length} ควรทบทวน`}
              </span>
              <button className="mm-btn ml-auto px-2" autoFocus title="ปิด" onClick={() => setLintOpen(false)}>
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {lintIssues.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  โปรเจกต์นี้ผ่านกฎทั้งหมด 👍
                </div>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {[...lintIssues]
                      .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
                      .map((i, n) => {
                        // แถวเป็นปุ่มพาไปหาการ์ดที่มีปัญหา — เดิมเจอ error แล้วต้องไปหาการ์ดเอง (ทางตัน)
                        const targetNodes = i.diagramId === cur ? nodes : allDiagrams[i.diagramId]?.nodes ?? [];
                        const target = targetNodes.find((x) => x.data.label === i.collection);
                        return (
                          <tr
                            key={`${i.diagramId}:${i.rule}:${i.collection}:${i.field ?? ""}:${n}`}
                            className={`border-b border-white/5 align-top ${target ? "cursor-pointer hover:bg-slate-800/60" : ""}`}
                            title={target ? `กดเพื่อไปหา "${i.collection}"` : undefined}
                            onClick={() => {
                              if (!target) return;
                              setLintOpen(false);
                              if (i.diagramId === cur) focusNode(target.id);
                              else focusCrossNode(i.diagramId, target.id);
                            }}
                          >
                            <td className="whitespace-nowrap py-1.5 pr-2">
                              <span className={i.level === "error" ? "text-red-400" : "text-amber-400"}>
                                {i.level === "error" ? "●" : "○"}
                              </span>
                            </td>
                            <td className="whitespace-nowrap py-1.5 pr-3 font-medium text-slate-200">
                              <span className="mr-1.5 rounded border border-slate-700 px-1 text-[9px] font-normal text-slate-400">
                                {i.diagram}
                              </span>
                              {i.collection}
                              {i.field ? <span className="text-slate-400">.{i.field}</span> : null}
                            </td>
                            <td className="py-1.5 pr-3 text-slate-300">{i.message}</td>
                            <td className="whitespace-nowrap py-1.5 text-[10px] text-slate-500">{i.rule}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {codeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setCodeOpen(false)}
        >
          <div
            className="mm-modal flex h-full max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-[var(--elev-3)]"
            role="dialog"
            aria-modal="true"
            aria-label="สร้างโค้ด"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 border-b border-slate-700 px-3 py-2">
              <span className="mr-2 text-sm font-semibold text-slate-200">⚙️ สร้างโค้ด</span>
              {CODE_TABS.map((t) => (
                <button
                  key={t}
                  className={`rounded-md px-2.5 py-1 text-xs ${
                    codeTab === t
                      ? "bg-sky-600 text-white"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  }`}
                  onClick={() => setCodeTab(t)}
                >
                  {t}
                </button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                {codeTab === "Wiki" && (
                  <button
                    className="rounded-md border border-sky-700 bg-sky-950 px-2.5 py-1 text-xs text-sky-300 hover:bg-sky-900"
                    title="เปิดหน้า wiki แบบ Obsidian ข้าง canvas (หน้าเดียวกัน)"
                    onClick={() => {
                      setCodeOpen(false);
                      onShowWiki(project);
                    }}
                  >
                    🌐 แสดงแบบ Obsidian
                  </button>
                )}
                {/* ขั้นสุดท้ายของทั้งแอป — เดิมกดแล้วเงียบสนิท (สำเร็จหรือถูกปฏิเสธก็เหมือนกัน) */}
                <button
                  className={`rounded-md border px-2.5 py-1 text-xs ${
                    copied === "ok"
                      ? "border-emerald-600 text-emerald-300"
                      : copied === "err"
                        ? "border-red-600 text-red-400"
                        : "border-slate-700 text-slate-300 hover:bg-slate-800"
                  }`}
                  onClick={() => {
                    void (async () => {
                      try {
                        await navigator.clipboard.writeText(codeText);
                        setCopied("ok");
                      } catch {
                        setCopied("err");
                      }
                      setTimeout(() => setCopied(null), 1800);
                    })();
                  }}
                >
                  {copied === "ok" ? "✓ คัดลอกแล้ว" : copied === "err" ? "✕ คัดลอกไม่สำเร็จ" : "📋 คัดลอก"}
                </button>
                <button
                  className="rounded-md px-2 py-1 text-slate-500 hover:text-slate-200"
                  title="ปิด"
                  autoFocus
                  onClick={() => setCodeOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>
            {/* เตือนตรงจุดที่กำลังจะเอาโค้ดไปใช้ — ไม่ปล่อยให้ได้สคริปต์พังเงียบๆ แล้วไปเจอตอนรัน */}
            {currentLintIssues.some((i) => i.level === "error") && (
              <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-950 px-4 py-1.5 text-xs text-amber-300">
                <span className="flex-1">
                  ⚠ 🩺 ตรวจพบ {currentLintIssues.filter((i) => i.level === "error").length} จุดที่ทำให้โค้ดนี้ใช้ไม่ได้จริง
                  (เช่น ชื่อซ้ำ/อักขระต้องห้าม) — แก้ก่อนนำไปใช้
                </span>
                <button
                  className="shrink-0 rounded border border-amber-700 px-2 py-0.5 hover:text-amber-100"
                  onClick={() => {
                    setCodeOpen(false);
                    setLintOpen(true);
                  }}
                >
                  เปิดดูรายการ
                </button>
              </div>
            )}
            <pre className="flex-1 overflow-auto p-4 text-xs leading-relaxed text-slate-300">{codeText}</pre>
          </div>
        </div>
      )}

      {/* เมนูคลิกขวา — ปิดเมื่อคลิกที่อื่น/Esc; ตำแหน่ง clamp ไม่ให้หลุดจอ */}
      {ctxMenu && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={() => setCtxMenu(null)}
          // preventDefault อย่างเดียว ห้ามปิดเมนู — เมนูจากพื้นที่ว่างถูกยิงตอน mouseup (panOnDrag ปุ่มขวา)
          // แล้ว event contextmenu จริงตามมาโดน overlay ที่เพิ่ง mount พอดี ถ้าปิดตรงนี้เมนูจะหายก่อนเห็น
          onContextMenu={(e) => e.preventDefault()}
        >
          <div
            className="mm-panel absolute w-56 overflow-hidden py-1 text-sm"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 240),
              top: Math.min(ctxMenu.y, window.innerHeight - 260),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.kind === "node" && (
              <>
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    const n = nodes.find((x) => x.id === ctxMenu.id);
                    if (n) setNodes((ns) => [...ns, cloneCollection(n, ns)]);
                    setCtxMenu(null);
                  }}
                >
                  ⧉ ทำซ้ำคอลเลกชัน <span className="float-right text-xs text-slate-500">Ctrl+D</span>
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    addFieldTo(ctxMenu.id);
                    setCtxMenu(null);
                  }}
                >
                  ＋ เพิ่มฟิลด์
                </button>
                {tabs.length > 1 && (
                  <div className="border-t border-white/5 pt-1">
                    <div className="px-3 py-0.5 text-[10px] text-slate-500">
                      ➡ ย้ายไปแท็บ… (เส้นเดิมกลายเป็นเส้นข้ามแท็บ)
                    </div>
                    {tabs
                      .filter((t) => t.id !== cur)
                      .map((t) => (
                        <button
                          key={t.id}
                          className="block w-full truncate px-5 py-1 text-left text-xs text-slate-300 hover:bg-slate-800"
                          onClick={() => {
                            moveNodeToTab(ctxMenu.id, t.id);
                            setCtxMenu(null);
                          }}
                        >
                          ▦ {t.name}
                        </button>
                      ))}
                  </div>
                )}
                <button
                  className="block w-full border-t border-white/5 px-3 py-1.5 text-left text-red-400 hover:bg-slate-800"
                  onClick={() => {
                    void deleteElements({ nodes: [{ id: ctxMenu.id }] });
                    setCtxMenu(null);
                  }}
                >
                  🗑 ลบคอลเลกชัน <span className="float-right text-xs text-slate-500">Delete</span>
                </button>
              </>
            )}
            {ctxMenu.kind === "edge" && (
              <>
                {compositeMembersById.has(ctxMenu.id) && (
                  <button
                    className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                    onClick={() => {
                      setInspectedEdgeId(ctxMenu.id);
                      setCtxMenu(null);
                    }}
                  >
                    ⛓ ดู mapping รายฟิลด์
                  </button>
                )}
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    const ed = displayEdges.find((x) => x.id === ctxMenu.id);
                    if (ed) onEdgeDoubleClick(null as unknown as ReactMouseEvent, ed);
                    setCtxMenu(null);
                  }}
                >
                  ↻ เปลี่ยนชนิดความสัมพันธ์
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left text-red-400 hover:bg-slate-800"
                  onClick={() => {
                    void deleteElements({ edges: [{ id: ctxMenu.id }] });
                    setCtxMenu(null);
                  }}
                >
                  🗑 ลบเส้นนี้
                </button>
              </>
            )}
            {ctxMenu.kind === "pane" && (
              <>
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    addCollection(screenToFlowPosition({ x: ctxMenu.x, y: ctxMenu.y }));
                    setCtxMenu(null);
                  }}
                >
                  ＋ เพิ่มคอลเลกชันตรงนี้
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    void autoLayout();
                    setCtxMenu(null);
                  }}
                >
                  ▦ จัดผังอัตโนมัติ
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left text-slate-200 hover:bg-slate-800"
                  onClick={() => {
            void fitView({ padding: 0.1, duration: 300 });
                    setCtxMenu(null);
                  }}
                >
                  ⛶ มองเห็นทั้งผัง (Fit View)
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ประวัติการแก้ไข — เปิด snapshot ฝั่ง server (เดิมมีแต่ทาง MCP) ให้ผู้ใช้กู้เองได้จาก UI */}
      {histOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setHistOpen(false)}
        >
          <div
            className="mm-modal mm-panel flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label="ประวัติการแก้ไข"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-semibold text-slate-200">🕘 ประวัติการแก้ไข</span>
              <span className="text-xs text-slate-500">snapshot อัตโนมัติทุกครั้งที่บันทึก (เก็บล่าสุด 20 ชุด)</span>
              <button className="mm-btn ml-auto px-2" autoFocus title="ปิด" onClick={() => setHistOpen(false)}>
                ✕
              </button>
            </div>
            <div className="border-b border-amber-900/50 bg-amber-950/50 px-4 py-1.5 text-[11px] text-amber-300">
              ⚠ การกู้คืนย้อน<b>ทั้ง workspace (ทุกโปรเจกต์)</b>กลับไปเวลานั้น — สถานะปัจจุบันถูกเก็บเป็น snapshot
              ใหม่ก่อนเสมอ กู้กลับมาได้
            </div>
            <div className="flex-1 overflow-auto p-2">
              {revisions === null ? (
                <div className="p-6 text-center text-sm text-slate-500">กำลังโหลด…</div>
              ) : revisions.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  ยังไม่มี snapshot — จะเริ่มเก็บเมื่อมีการบันทึกครั้งถัดไป
                </div>
              ) : (
                revisions.map((r) => (
                  <div
                    key={r.rev}
                    className="flex items-center gap-3 rounded px-3 py-2 text-sm hover:bg-slate-800/60"
                  >
                    <span className="w-16 shrink-0 text-xs text-slate-500">rev {r.rev}</span>
                    <span className="flex-1 text-slate-300">
                      {new Date(r.savedAt).toLocaleString("th-TH")}
                    </span>
                    <button
                      className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-sky-600 hover:text-sky-300"
                      onClick={() => {
                        void (async () => {
                          if (
                            !(await askConfirm({
                              title: `กู้คืน workspace ไปที่ rev ${r.rev}?`,
                              description: `${new Date(r.savedAt).toLocaleString("th-TH")}\nทุกโปรเจกต์จะย้อนกลับไปเวลานั้น — สถานะปัจจุบันถูกเก็บเป็น snapshot ก่อน`,
                              confirmLabel: "กู้คืนทั้ง workspace",
                              destructive: true,
                            }))
                          )
                            return;
                          try {
                            const res = await fetch("/api/revisions", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ rev: r.rev }),
                            });
                            if (!res.ok) throw new Error();
                            setHistOpen(false);
                            await bootstrap(); // โหลดข้อมูลชุดที่กู้กลับมาเข้าจอทันที
                            notify(`🕘 กู้คืน workspace กลับไปที่ rev ${r.rev} แล้ว`, 4000);
                          } catch {
                            window.alert("กู้คืนไม่สำเร็จ — snapshot อาจถูกลบไปแล้ว ลองเปิดประวัติใหม่");
                          }
                        })();
                      }}
                    >
                      ↩ กู้คืน
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {confirmRequest && (
        <ConfirmDialog
          {...confirmRequest}
          onCancel={() => settleConfirm(false)}
          onConfirm={() => settleConfirm(true)}
        />
      )}
    </div>
  );
}

// ---------- หน้าเลือก/จัดการโปรเจกต์ (ไม่ต้องเปิด folder — ทำในจอทั้งหมด) ----------

type ProjectSummary = {
  name: string;
  rev: number;
  updatedAt: string;
  diagrams: number;
  collections: number;
};

function ProjectHome({
  onOpen,
  onOffline,
  onShowWiki,
  theme,
  onToggleTheme,
}: {
  onOpen: (name: string) => void;
  onOffline: () => void;
  onShowWiki: (name: string) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // modal ยืนยันลบ (native confirm โดน auto-dismiss ในบางบริบท = กดแล้วเงียบ)
  const [error, setError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const lastWsRev = useRef(0); // workspace rev ล่าสุด — ส่ง ?rev= ตอน poll (204 = ไม่ต้องทำอะไร)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects?rev=${lastWsRev.current}`);
      if (res.status === 204) return; // workspace rev เดิม — ไม่มีอะไรเปลี่ยน
      if (!res.ok) throw new Error();
      const json = await res.json();
      if (typeof json.rev === "number") lastWsRev.current = json.rev;
      let projects = (json.projects ?? []) as ProjectSummary[];
      // คงลำดับที่แสดงอยู่เดิม (server เรียงตาม updatedAt — ถ้า AI/คนอื่นแก้โปรเจกต์อื่นระหว่าง poll
      // การ์ดจะสลับตำแหน่งใต้เมาส์แล้วคลิกพลาด) — รายการใหม่ต่อท้ายตามลำดับ server
      const keepOrder = (prev: ProjectSummary[] | null, next: ProjectSummary[]) => {
        if (!prev) return next;
        const idx = new Map(prev.map((x, i) => [x.name, i]));
        return [...next].sort(
          (a, b) => (idx.get(a.name) ?? Infinity) - (idx.get(b.name) ?? Infinity)
        );
      };
      // migrate ครั้งแรก — server ว่าง + localStorage เคยมีงาน + ยังไม่เคย sync → ยกขึ้นเป็น project "default"
      if (
        projects.length === 0 &&
        !localStorage.getItem(SYNCED_KEY) &&
        localStorage.getItem(INDEX_KEY)
      ) {
        const idx = loadIndex();
        const diagrams: Record<string, unknown> = {};
        for (const t of idx.tabs) diagrams[t.id] = loadDiagram(t.id);
        await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "default" }),
        });
        await fetch("/api/projects/default", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabs: idx.tabs, cur: idx.cur, diagrams }),
        });
        localStorage.setItem(SYNCED_KEY, "1");
        projects = ((await (await fetch("/api/projects")).json()).projects ??
          []) as ProjectSummary[];
      }
      setList((prev) => keepOrder(prev, projects));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  // โหลดครั้งแรก + auto refresh ทุก 5 วิ — AI สร้าง/ลบ/เปลี่ยนชื่อ project ผ่าน MCP ก็เห็นทันที
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [load]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "สร้างไม่สำเร็จ");
      return;
    }
    setNewName("");
    setError("");
    onOpen(name);
  };

  const doRename = async (old: string) => {
    const name = renameText.trim();
    setRenaming(null);
    if (!name || name === old) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(old)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      alert(j.error ?? "เปลี่ยนชื่อไม่สำเร็จ");
    }
    void load();
  };

  // ลบจริงหลังยืนยันใน modal ของแอปเอง — native confirm() แสดงผลไม่คงเส้นคงวา (automation/บาง browser
  // auto-dismiss เงียบ) ผู้ใช้กดปุ่มลบแล้วไม่เห็นอะไรเกิดขึ้นเลย
  const del = async (name: string) => {
    setConfirmDel(null);
    await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" });
    void load();
  };

  // นำเข้าไฟล์ = สร้างเป็น project ใหม่เสมอ (ชื่อซ้ำเติมเลขท้าย)
  const importProject = (file: File) =>
    readFile(file, (list) => {
      void (async () => {
        const base = file.name.replace(/\.json$/i, "") || "imported";
        let name = base;
        for (let i = 2; ; i++) {
          const res = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (res.ok) break;
          if (res.status !== 409 || i > 50) {
            alert("นำเข้าไม่สำเร็จ — สร้าง project ไม่ได้");
            return;
          }
          name = `${base} ${i}`;
        }
        const newTabs = list.map((d) => ({ id: uid(), name: d.name }));
        const diagrams = Object.fromEntries(
          newTabs.map((t, i) => [t.id, { nodes: list[i].nodes, edges: list[i].edges }])
        );
        await fetch(`/api/projects/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabs: newTabs, cur: newTabs[0].id, diagrams }),
        });
        onOpen(name);
      })();
    });

  return (
    <div className="flex h-screen flex-col items-center overflow-auto bg-slate-950 px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-2 flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-emerald-500" />
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">MongoModel</h1>
          <span className="text-xs text-slate-500">ออกแบบโครงสร้างข้อมูล MongoDB</span>
          <div className="ml-auto">
            <ThemeButton theme={theme} onToggle={onToggleTheme} />
          </div>
        </div>
        {/* บอก scope ของแอปให้ผู้ใช้ใหม่รู้ก่อนกดสร้าง — ไม่ต้องเดาว่าแอปทำอะไรได้ */}
        <div className="mb-6 text-xs leading-relaxed text-slate-500">
          ลากวางออกแบบ collection → เชื่อม relation แบบ field→field → 🩺 ตรวจโมเดล → ⚙️ สร้างโค้ด
          mongosh/Go/Mongoose/TypeScript + 📖 Wiki — ให้ AI ช่วยแก้ผังได้ผ่าน MCP
        </div>

        {offline ? (
          <div className="rounded-lg border border-yellow-900 bg-yellow-950 p-4 text-sm text-yellow-300">
            ⚠ เชื่อมต่อ server ไม่ได้ — ระบบ project ต้องใช้ server ที่รันอยู่
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-lg border border-yellow-700 px-3 py-1.5 text-xs hover:bg-yellow-900"
                onClick={() => void load()}
              >
                🔄 ลองใหม่
              </button>
              <button
                className="rounded-lg border border-yellow-700 px-3 py-1.5 text-xs hover:bg-yellow-900"
                onClick={onOffline}
              >
                ใช้งานออฟไลน์ (localStorage)
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex gap-2">
              <input
                className="mm-input flex-1 px-3.5 py-2.5 text-sm"
                placeholder="ชื่อโปรเจกต์ใหม่…"
                aria-label="ชื่อโปรเจกต์ใหม่"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
              <button
                className="mm-btn mm-btn-primary px-4 py-2.5"
                onClick={() => void create()}
              >
                ＋ สร้างโปรเจกต์
              </button>
              <button
                className="mm-btn px-4 py-2.5"
                title="นำเข้าไฟล์ JSON (ส่งออก/สำรองจาก MongoModel) เป็น project ใหม่"
                onClick={() => importInput.current?.click()}
              >
                📥 นำเข้า
              </button>
              <input
                ref={importInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                aria-label="เลือกไฟล์ JSON ที่จะนำเข้าเป็นโปรเจกต์ใหม่"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importProject(f);
                  e.target.value = "";
                }}
              />
            </div>
            {error && <div className="mb-3 text-xs text-red-400">{error}</div>}

            {list === null ? (
              <div className="text-sm text-slate-500">กำลังโหลด…</div>
            ) : list.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-10 text-center text-sm text-slate-500">
                ยังไม่มีโปรเจกต์ — สร้างอันแรกจากช่องด้านบน หรือนำเข้าไฟล์ (เช่น erp-example.json)
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {list.map((p) => (
                  <div
                    key={p.name}
                    className="mm-panel flex items-center gap-3 px-4 py-3.5 transition-colors hover:border-sky-500/40"
                  >
                    {renaming === p.name ? (
                      <input
                        autoFocus
                        className="flex-1 rounded border border-sky-600 bg-slate-950 px-2 py-1 text-sm text-slate-100 outline-none"
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void doRename(p.name);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => void doRename(p.name)}
                      />
                    ) : (
                      <button className="flex-1 text-left" onClick={() => onOpen(p.name)}>
                        <div className="font-medium text-slate-100">{p.name}</div>
                        <div className="text-xs text-slate-500">
                          {p.diagrams} diagram · {p.collections} collection · แก้ล่าสุด{" "}
                          {new Date(p.updatedAt).toLocaleString("th-TH")}
                        </div>
                      </button>
                    )}
                    <button
                      className="mm-ico text-slate-400 hover:text-sky-300"
                      title="แสดงแบบ Obsidian (Wiki)"
                      onClick={() => onShowWiki(p.name)}
                    >
                      🌐
                    </button>
                    <button
                      className="mm-ico text-slate-400 hover:text-slate-200"
                      title="เปลี่ยนชื่อ"
                      onClick={() => {
                        setRenaming(p.name);
                        setRenameText(p.name);
                      }}
                    >
                      ✏️
                    </button>
                    {/* ปุ่มทำลาย — แยกกลุ่มด้วยเส้นคั่น+ระยะ (เดิมห่างจากปุ่มเปลี่ยนชื่อแค่ 12px
                        และกว้างแค่ 11px ทั้งที่ผลรุนแรงที่สุดในแถว) */}
                    <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
                    <button
                      className="mm-ico text-slate-400 hover:bg-red-500/15 hover:text-red-400"
                      title="ลบโปรเจกต์"
                      onClick={() => setConfirmDel(p.name)}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 text-xs text-slate-400">
              AI อื่นเชื่อมผ่าน MCP ได้ที่{" "}
              <code className="text-slate-400">http://localhost:3100/mcp</code> — ทุก tool
              ระบุชื่อโปรเจกต์เสมอ ทำได้หลายโปรเจกต์พร้อมกัน
            </div>
          </>
        )}
      </div>

      {confirmDel !== null && (
        <ConfirmDialog
          title={`ลบโปรเจกต์ “${confirmDel}” ?`}
          description="ลบถาวร — ทุก diagram ในโปรเจกต์นี้หายหมด\nกู้คืนได้จาก 🕘 ประวัติ ซึ่งย้อนทั้ง workspace หรือ MCP restore_revision"
          confirmLabel="🗑 ลบถาวร"
          destructive
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => void del(confirmDel)}
        />
      )}
    </div>
  );
}

// ---------- ตัวแอป: หน้าเลือกโปรเจกต์ ↔ designer + wiki ข้างกันในหน้าเดียวกัน ----------

// wiki แบบ Obsidian — panel = แผงข้าง canvas, overlay = เต็มจอ (หน้าเลือกโปรเจกต์)
// poll ทุก 3 วิให้เนื้อหาตามการแก้ diagram เสมอ (canvas autosave ขึ้น server อยู่แล้ว)
function WikiOverlay({
  project,
  panel,
  onClose,
}: {
  project: string;
  panel?: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<WikiData | null>(null);
  const [error, setError] = useState(false);
  const revRef = useRef(""); // rev ของ WikiData รอบล่าสุด — ส่ง ?rev= ตอน poll (204 = ไม่เปลี่ยน)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/wiki/${encodeURIComponent(project)}?rev=${revRef.current}`
        );
        if (res.status === 204) return; // rev เดิม — ไม่มีอะไรเปลี่ยน
        if (!res.ok) throw new Error();
        const j = (await res.json()) as WikiData;
        revRef.current = String(j.rev);
        if (alive) setData(j);
      } catch {
        if (alive) setError(true);
      }
    };
    void load();
    const iv = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [project]);
  return (
    <div className={panel ? "h-full bg-slate-950" : "fixed inset-0 z-50 bg-slate-950"}>
      {data ? (
        <WikiViewer data={data} onClose={onClose} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-500">
          {error ? (
            <>
              <span>โหลด wiki ไม่สำเร็จ</span>
              <button className="rounded-lg border border-slate-700 px-3 py-1.5 hover:bg-slate-800" onClick={onClose}>
                ✕ ปิด
              </button>
            </>
          ) : (
            "กำลังเตรียม wiki…"
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const [theme, toggleTheme] = useTheme();
  const [project, setProject] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [wiki, setWiki] = useState<string | null>(null); // โปรเจกต์ที่เปิด wiki อยู่

  // deep link: /?project=<ชื่อ> — bookmark/refresh แล้วกลับเข้าโปรเจกต์เดิมได้เลย
  // (client component — อ่าน URL ได้หลัง mount เท่านั้น; ชื่อไม่ถูกต้อง bootstrap จะพากลับหน้าเลือกเอง)
  // defer 1 tick กัน setState กลาง effect flush (pattern เดียวกับ bootstrap)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("project");
    if (!q) return;
    const t = setTimeout(() => setProject(q), 0);
    return () => clearTimeout(t);
  }, []);
  // เปิด/ปิดโปรเจกต์ = push ประวัติเบราว์เซอร์ — ปุ่ม Back พากลับหน้าเลือกโปรเจกต์ได้จริง
  // (replaceState เดิมทำให้กด Back แล้วเงียบ) · ข้าม mount แรก (กัน push "/" ทับ deep link ก่อนโหลด)
  // · URL ตรงอยู่แล้ว (มาจาก popstate/deep-link) = ไม่ push ซ้ำ
  const historyBooted = useRef(false);
  useEffect(() => {
    if (!historyBooted.current) {
      historyBooted.current = true;
      return;
    }
    const url = project ? `/?project=${encodeURIComponent(project)}` : "/";
    if (window.location.pathname + window.location.search !== url)
      window.history.pushState(null, "", url);
  }, [project]);
  // ปุ่ม Back/Forward ของเบราว์เซอร์ → sync state ตาม URL (ไม่ push ซ้ำเพราะ URL ตรงแล้ว)
  useEffect(() => {
    const onPop = () => {
      setProject(new URLSearchParams(window.location.search).get("project"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // เปิด designer ของโปรเจกต์เดียวกับ wiki → แสดงข้างกัน (split) ไม่ใช่ทับเต็มจอ
  const split = wiki !== null && wiki === project && !offline;
  // toggle — ปุ่ม 📖 Wiki บน toolbar กดซ้ำ = ปิด
  const toggleWiki = (name: string) => setWiki((w) => (w === name ? null : name));
  const openProject = (name: string) => {
    setProject(name);
    if (wiki !== null && wiki !== name) setWiki(null); // wiki คนละโปรเจกต์ → ปิดกันสับสน
  };
  return (
    <div className={split ? "flex h-screen" : undefined}>
      <div className={split ? "min-w-0 flex-1" : undefined}>
        {offline ? (
          // provider ครอบเฉพาะ Designer — แยก store จาก ReactFlow ของ wiki graph (กัน node types ชนกัน)
          <ReactFlowProvider>
            <Designer
              project="(ออฟไลน์ — localStorage)"
              offline
              onExit={() => setOffline(false)}
              onShowWiki={toggleWiki}
              wikiOpen={false}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          </ReactFlowProvider>
        ) : project === null ? (
          <ProjectHome onOpen={openProject} onOffline={() => setOffline(true)} onShowWiki={toggleWiki} theme={theme} onToggleTheme={toggleTheme} />
        ) : (
          // key=project → สลับโปรเจกต์ = remount สะอาด
          <ReactFlowProvider key={project}>
            <Designer
              project={project}
              offline={false}
              onExit={() => setProject(null)}
              onShowWiki={toggleWiki}
              wikiOpen={wiki === project}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
          </ReactFlowProvider>
        )}
      </div>
      {wiki !== null &&
        (split ? (
          <div className="w-[45%] shrink-0 border-l border-slate-800">
            <WikiOverlay project={wiki} panel onClose={() => setWiki(null)} />
          </div>
        ) : (
          <WikiOverlay project={wiki} onClose={() => setWiki(null)} />
        ))}
    </div>
  );
}

export default function Page() {
  return <App />;
}
