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
  FIELD_TYPES,
  type FieldType,
  type Field,
  type CollectionData,
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
  toWiki,
  isThaiText,
  keyGroupsOf,
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
type DiagramMeta = { id: string; name: string };

// สถานะ popup ป้อนรายละเอียด (แทน window.prompt)
type EditState =
  | { kind: "collDesc"; text: string }
  | { kind: "fieldDesc"; fid: string; name: string; text: string }
  | { kind: "enumDefault"; fid: string; name: string; enumText: string; def: string }
  | { kind: "keyGroup"; fid: string; name: string; text: string };

const uid = () => crypto.randomUUID().slice(0, 8);
const INDEX_KEY = "mongomodel:index";
const LEGACY_KEY = "mongomodel";
const dataKey = (id: string) => `mongomodel:d:${id}`;
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

// กลุ่ม key ที่ pin บนสุดของ collection: PK(_id ตัวแรก) / key(🔑) / sessionkey(🌐) / keygroup(⛓ key ผสม) — field อื่นตามหลัง
const isKeyField = (fields: Field[], f: Field): boolean =>
  Boolean(f.key || f.sessionkey || f.keygroup || (f.name === "_id" && fields.find((o) => o.name === "_id") === f));

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
const cloneFields = (fs: Field[]): Field[] =>
  fs.map((f) => ({
    ...f,
    id: uid(),
    children: f.children ? cloneFields(f.children) : undefined,
  }));

// clone คอลเลกชัน — regenerate field id ทุกตัว กัน handle ชนกับต้นฉบับ
const cloneCollection = (n: CollectionNode): CollectionNode => ({
  id: uid(),
  type: "collection",
  // วางข้างขวาพ้นความกว้างจริงของต้นฉบับ — +40 เดิมซ้อนทับจนกดปุ่ม node ใหม่/เก่าไม่ได้
  position: { x: n.position.x + (n.measured?.width ?? 256) + 24, y: n.position.y },
  selected: false,
  data: {
    ...n.data,
    label: `${n.data.label}_copy`,
    fields: cloneFields(n.data.fields),
  },
});

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
  dragIndexRef,
}: FieldRowProps) {
  const top = depth === 0;
  const nest = canNest(f);
  // field ที่เป็น key (PK/🔑/🌐/⛓ keygroup) ไม่วาดจุดเชื่อมที่แถวตัวเอง — ย้ายไปรวมที่แถบ key ด้านบนการ์ด (KeyBar ใน CollectionNodeView) handle id เหมือนเดิมเส้นไม่พัง
  const keyHandles = top && (isPK || f.key || f.sessionkey || Boolean(f.keygroup));
  const nameErr =
    f.name.trim() === ""
      ? "ชื่อว่าง"
      : siblings.some((o) => o.id !== f.id && o.name === f.name)
        ? "ชื่อซ้ำ"
        : "";
  return (
    <>
      <div className="relative flex items-center gap-1.5">
        {/* relation เป็น field→field: ต้นเส้น -s ซ้าย (FK) ปลายเส้น -t ขวา (business key ที่ถูกอ้าง) — ไม่มี handle ระดับ node */}
        {/* จับ ⠿ ลากปล่อยเพื่อจัดลำดับ field — เฉพาะ top-level */}
        {top && (
          <span
            className="nodrag shrink-0 cursor-grab select-none text-slate-600 opacity-40 hover:text-slate-300 active:cursor-grabbing"
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
        {/* _id = primary key ของ MongoDB — first-wins ตรงกับ codegen (เฉพาะ top-level); f.key = business key ที่ collection อื่นอ้างอิง; f.sessionkey = tenant/session scope (เช่น holdingcode); f.keygroup = สมาชิก key ผสม (⛓)
            ปุ่ม * (required) แสดงควบคู่ไอคอน key เสมอ ยกเว้น PK (_id บังคับ required อยู่แล้ว) — สมาชิก key ผสมต้อง toggle required ได้ตามที่ 🩺 ตรวจแนะนำ */}
        <span className="flex min-w-8 shrink-0 items-center justify-center gap-0.5 text-xs">
          {(isPK || f.key) && (
            <span title={isPK ? "Primary key" : "Business key — collection อื่นอ้างอิง field นี้"}>🔑</span>
          )}
          {f.sessionkey && <span title="Session key — tenant scope (เช่น holdingcode)">🌐</span>}
          {f.keygroup && <span title={`สมาชิก key ผสม (กลุ่ม "${f.keygroup}") — รวมกับ field อื่นในกลุ่มเป็น key เดียว`}>⛓</span>}
          {!isPK && (
            <button
              className={`nodrag font-bold ${f.required ? "text-red-400" : "text-slate-600 hover:text-slate-400"}`}
              title={f.required ? "จำเป็นต้องมี (คลิกเพื่อยกเลิก)" : "ไม่บังคับ (คลิกเพื่อบังคับ)"}
              onClick={() => onPatch(f.id, { required: !f.required })}
            >
              *
            </button>
          )}
        </span>
        {/* พับ/ขยายฟิลด์ย่อย — เฉพาะชนิดที่มีลูกได้ */}
        {nest && (
          <button
            className="nodrag w-3 shrink-0 text-center text-slate-400 hover:text-slate-200"
            title={f.collapsed ? "ขยายฟิลด์ย่อย" : "พับฟิลด์ย่อย"}
            onClick={() => onPatch(f.id, { collapsed: !f.collapsed })}
          >
            {f.collapsed ? "▸" : "▾"}
          </button>
        )}
        <input
          className={`nodrag w-0 flex-1 rounded px-1 py-0.5 outline-none hover:bg-slate-700/60 focus:bg-slate-700 ${
            f.name === "_id" && top ? "font-semibold text-amber-200" : "text-slate-200"
          } ${nameErr ? "ring-1 ring-red-500" : ""}`}
          value={f.name}
          placeholder="ชื่อฟิลด์"
          title={nameErr || undefined}
          onChange={(e) => onPatch(f.id, { name: e.target.value })}
        />
        <span className="w-5 shrink-0 text-center text-[10px] text-slate-500" title={f.type}>
          {TYPE_ICON[f.type] ?? "?"}
        </span>
        <select
          className="nodrag shrink-0 rounded bg-slate-700 px-1 py-0.5 text-[11px] text-slate-300 outline-none"
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
        {/* actions รอง — ค้างตลอด ไม่ซ่อนตอน hover (กันจอกระตุกตอนเลื่อน) */}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.enum?.length || f.default != null ? "text-sky-300" : "text-slate-500 hover:text-slate-300"
            }`}
            title="ตั้ง enum / ค่าเริ่มต้น"
            onClick={() => onEditEnumDefault(f)}
          >
            ◇
          </button>
        )}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.key ? "opacity-100" : "opacity-30 hover:opacity-70"
            }`}
            title={f.key ? "business key — collection อื่นอ้างอิง field นี้ (คลิกเพื่อยกเลิก)" : "ตั้งเป็น business key (🔑)"}
            onClick={() => onPatch(f.id, { key: !f.key })}
          >
            🔑
          </button>
        )}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.sessionkey ? "opacity-100" : "opacity-30 hover:opacity-70"
            }`}
            title={f.sessionkey ? "session key — tenant scope (คลิกเพื่อยกเลิก)" : "ตั้งเป็น session key (🌐)"}
            onClick={() => onPatch(f.id, { sessionkey: !f.sessionkey })}
          >
            🌐
          </button>
        )}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.keygroup ? "text-sky-300 opacity-100" : "opacity-30 hover:opacity-70"
            }`}
            title={f.keygroup ? `key ผสม กลุ่ม "${f.keygroup}" (คลิกเพื่อแก้/ออกจากกลุ่ม)` : "ตั้ง key ผสม — หลาย field รวมเป็น key เดียว (⛓)"}
            onClick={() => onEditKeyGroup(f)}
          >
            ⛓
          </button>
        )}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] font-bold ${
              f.unique ? "text-amber-300" : "text-slate-600 hover:text-slate-400"
            }`}
            title="unique index"
            onClick={() => onPatch(f.id, { unique: !f.unique })}
          >
            U
          </button>
        )}
        {/* array ของ object เท่านั้น — ยืนยันว่ามีขอบเขต (ไม่โตไม่จำกัดจนชนเพดานเอกสาร 16MB) */}
        {f.type === "Array" && (f.of === "Object" || (f.children?.length ?? 0) > 0) && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.bounded ? "text-emerald-300" : "text-slate-600 hover:text-slate-400"
            }`}
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
          className={`nodrag shrink-0 text-[10px] ${
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
        <button
          className="nodrag text-slate-600 hover:text-red-400"
          title="ลบฟิลด์"
          onClick={() => onRemove(f.id)}
        >
          ✕
        </button>
        {/* จุดเชื่อมลอยนอกการ์ด แยกตำแหน่งกัน: -s (FK ต้นเส้น) นอก 10px, -t (amber ปลายทาง) นอก 24px — ไม่ทับไอคอนในแถว ไม่ทับกันเอง หัวลูกศรอยู่นอกการ์ดเห็นชัด
            ข้างที่ใช้เลือกอัตโนมัติตอน render (displayEdges); เก็บ canonical -s/-t (normalize ตอน onConnect); ลากเริ่มได้ทั้ง 2 ฝั่ง React Flow จัดทิศตาม type เอง
            key field (PK/🔑/🌐) ข้ามตรงนี้ — จุดเชื่อมอยู่ที่แถบ key ด้านบนการ์ดแทน */}
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
          className="nodrag mt-0.5 cursor-text whitespace-pre-wrap break-words pl-[38px] pr-1 text-[10px] leading-snug text-slate-400/90"
          title="คลิกเพื่อแก้คำอธิบาย"
          onClick={() => onEditDesc(f)}
        >
          {f.description}
        </div>
      )}
      {/* enum / default — แสดง inline ถ้าตั้งไว้ (ตั้งได้เฉพาะ top-level) */}
      {top && ((f.enum?.length ?? 0) > 0 || f.default != null) && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 pl-[22px] pr-1 text-[10px] leading-snug text-slate-400/90 break-words">
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
        <div className={depth < 6 ? "pl-3.5" : ""}>
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
              dragIndexRef={dragIndexRef}
            />
          ))}
          <button
            className="nodrag block py-0.5 pl-[22px] text-left text-[10px] text-sky-400/80 hover:text-sky-300"
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
  const { updateNodeData, deleteElements, getEdges, getNode, addNodes } =
    useReactFlow<CollectionNode>();
  const [editingLabel, setEditingLabel] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [editError, setEditError] = useState(""); // error validate คำอธิบายไทยใน popup (ว่าง/ไม่ใช่ไทย)
  const dragIndex = useRef<number | null>(null); // index ของ field ที่กำลังลาก

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

  // key ทั้งหมดของ collection (PK ตัวแรก/🔑/🌐/⛓ keygroup) — แสดงสรุปที่แถบ key ด้านบนการ์ด พร้อมจุดเชื่อมเส้น (ย้ายมาจากแถว field)
  const keyFields = data.fields.filter((f) => isKeyField(data.fields, f));
  // กลุ่ม key ผสม — fields ที่มี keygroup เดียวกันรวมแสดงเป็นกลุ่มเดียว (⛓ a + b + c) สมาชิกแต่ละตัวยังมีจุดเชื่อมของตัวเอง
  const keyGroups = keyGroupsOf(data.fields);
  const groupMemberIds = new Set(keyGroups.flatMap((g) => g.fields.map((f) => f.id)));
  const soloKeys = keyFields.filter((f) => !groupMemberIds.has(f.id));

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
      <div key={f.id} className="relative flex items-center gap-1.5 py-0.5">
        {/* spacer ความกว้างเท่า grip ⠿ ของแถว field — ให้คอลัมน์ไอคอน/ชื่อของ key ตรงระดับซ้ายกับแถว field (key กับ field คนละเรื่องกัน แต่ต้องเรียงระดับเดียวกัน) */}
        <span className="invisible shrink-0 select-none" aria-hidden="true">⠿</span>
        <span className="flex min-w-8 shrink-0 items-center justify-center gap-0.5 text-xs">
          {(pk || f.key) && (
            <span title={pk ? "Primary key" : "Business key — collection อื่นอ้างอิง field นี้"}>🔑</span>
          )}
          {f.sessionkey && <span title="Session key — tenant scope (เช่น holdingcode)">🌐</span>}
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
        <span className="text-[10px] text-slate-500" title={f.type}>
          {TYPE_ICON[f.type] ?? "?"}
        </span>
        {reorder && (
          <span className="nodrag ml-auto flex shrink-0 items-center">
            <button
              className="px-0.5 text-[10px] text-slate-500 hover:text-sky-300 disabled:opacity-20 disabled:hover:text-slate-500"
              title="เลื่อนขึ้น — ลำดับใน key ผสมมีผลต่อ compound index (prefix)"
              disabled={reorder.first}
              onClick={reorder.onUp}
            >
              ↑
            </button>
            <button
              className="px-0.5 text-[10px] text-slate-500 hover:text-sky-300 disabled:opacity-20 disabled:hover:text-slate-500"
              title="เลื่อนลง — ลำดับใน key ผสมมีผลต่อ compound index (prefix)"
              disabled={reorder.last}
              onClick={reorder.onDown}
            >
              ↓
            </button>
            <button
              className="px-0.5 text-[10px] text-slate-500 hover:text-red-400"
              title="เอาออกจาก key ผสม (field ยังอยู่)"
              onClick={reorder.onRemove}
            >
              ✕
            </button>
          </span>
        )}
        {refs.length > 0 && (
          <span
            className="ml-auto rounded bg-amber-400/15 px-1.5 text-[10px] text-amber-300"
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

  // เอาสมาชิกออกจาก key ผสม (field ยังอยู่ — แค่ล้าง keygroup; ถ้ายังมี key/🌐 จะไปอยู่แถว key เดี่ยวแทน)
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

  const patchField = (fid: string, patch: Partial<Field>) => {
    const patched = updateFieldInTree(data.fields, fid, patch);
    // ติดธง key/sessionkey/keygroup ปุ๊บ pin ขึ้นกลุ่ม key ด้านบนทันที (เฉพาะระดับบน)
    updateNodeData(id, {
      fields:
        patch.key === true || patch.sessionkey === true || (typeof patch.keygroup === "string" && patch.keygroup !== "")
          ? pinKeyField(patched, fid)
          : patched,
    });
  };

  const removeField = (fid: string) => {
    updateNodeData(id, { fields: removeFieldInTree(data.fields, fid) });
    // ลบเส้นเชื่อมที่ค้างอยู่กับฟิลด์นี้ — ต้องผ่าน deleteElements (เดินผ่าน onEdgesChange)
    // เพราะ edges เป็น controlled state ของ Designer: setEdges ของ useReactFlow แก้แค่ store ภายใน แล้วโดนเขียนทับ = เส้นค้างถาวร
    // handle ใน store เป็นแบบเลือกข้างแล้ว (-s-l/-s-r) ส่วนข้อมูลเก็บ canonical (-s/-t) → เทียบด้วย field id หลังตัด suffix
    const dead = getEdges().filter(
      (e) =>
        (e.source === id && e.sourceHandle?.replace(/-s(-[lr])?$/, "") === fid) ||
        (e.target === id && e.targetHandle?.replace(/-t(-[lr])?$/, "") === fid)
    );
    if (dead.length) deleteElements({ edges: dead.map((e) => ({ id: e.id })) });
  };

  const addField = () => {
    // สร้างแล้วเปิดช่องใส่คำอธิบายทันที (บังคับภาษาไทย) — ถ้ายกเลิกจะเหลือ marker เหลืองเตือน
    const nf: Field = {
      id: uid(),
      name: "field_" + (data.fields.length + 1),
      type: "String" as FieldType,
      required: false,
    };
    updateNodeData(id, { fields: [...data.fields, nf] });
    editFieldDescription(nf);
  };

  const addChild = (parentId: string) => {
    const nf: Field = { id: uid(), name: "field", type: "String" as FieldType, required: false };
    updateNodeData(id, { fields: addChildInTree(data.fields, parentId, nf) });
    editFieldDescription(nf);
  };

  const duplicate = () => {
    const n = getNode(id);
    if (n) addNodes(cloneCollection(n));
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
    setEditing({ kind: "collDesc", text: data.description ?? "" });
  };
  const editFieldDescription = (f: Field) => {
    setEditError("");
    setEditing({ kind: "fieldDesc", fid: f.id, name: f.name, text: f.description ?? "" });
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
      className={`mm-card w-full min-w-[22rem] border text-xs ${selected ? "mm-card-selected border-sky-400/70" : "border-white/10"}`}
    >
      {/* ลากขอบขวาปรับความกว้าง (สูง auto, width เก็บถาวรใน node) */}
      <NodeResizeControl
        variant={ResizeControlVariant.Line}
        position="right"
        minWidth={352}
        maxWidth={1000}
        color="#38bdf8"
      />

      {/* หัวคอลเลกชัน */}
      <div
        className={`mm-card-head relative flex items-center gap-2 border-b border-white/10 px-3 py-2 ${labelErr ? "ring-1 ring-red-500" : ""}`}
        title={labelErr || undefined}
      >
        {/* ไม่มี handle ระดับ node — relation ต้องชี้ลง field เป้าหมาย (business key) เสมอ */}
        {/* ชื่อเป็นข้อความ → กดค้างที่หัวเพื่อย้าย node ได้, ดับเบิลคลิกเพื่อแก้ inline */}
        {editingLabel ? (
          <input
            className="nodrag w-0 flex-1 rounded bg-blue-950 px-1 py-0.5 text-sm font-semibold text-slate-100 outline-none ring-1 ring-sky-500"
            autoFocus
            defaultValue={data.label}
            onFocus={(e) => e.currentTarget.select()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              updateNodeData(id, { label: e.currentTarget.value.trim() });
              setEditingLabel(false);
            }}
            onKeyDown={(e) => {
              e.stopPropagation(); // กัน react flow / คีย์ลัด global จับ
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                e.currentTarget.value = data.label; // ยกเลิก = คืนค่าเดิมก่อน blur commit
                e.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span
            className="flex-1 truncate text-sm font-semibold text-slate-100"
            title="กดค้างเพื่อย้าย • ดับเบิลคลิกเพื่อแก้ชื่อ"
            onDoubleClick={() => setEditingLabel(true)}
          >
            {data.label || <span className="font-normal text-blue-300">ชื่อคอลเลกชัน</span>}
          </span>
        )}
        <button
          className={`nodrag shrink-0 text-xs ${
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
          className="nodrag shrink-0 text-blue-300 hover:text-sky-300"
          title="ทำซ้ำคอลเลกชัน (Ctrl+D)"
          onClick={duplicate}
        >
          ⧉
        </button>
        <button
          className="nodrag shrink-0 text-blue-300 hover:text-red-400"
          title="ลบคอลเลกชัน"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ✕
        </button>
      </div>

      {/* คำอธิบายคอลเลกชัน — แสดง inline ถ้ามี */}
      {data.description && (
        <div className="border-b border-slate-700/60 bg-slate-800/40 px-3 py-1 text-[11px] italic leading-snug text-slate-400 whitespace-pre-wrap break-words">
          {data.description}
        </div>
      )}

      {/* แถบ key — สรุป key ทั้งหมดของ collection (PK/🔑/🌐/⛓ key ผสม) ไว้ด้านบนเสมอ พร้อมจุดเชื่อมเส้นข้างการ์ด (ลากเชื่อม collection อื่นมาที่ key ได้เลย) + badge จำนวนที่ถูกอ้าง */}
      {keyFields.length > 0 && (
        <div className="border-b border-slate-700/60 bg-blue-950/40 px-3 py-1">
          <div className="text-[10px] font-semibold tracking-wide text-sky-300/80">
            🔑 key ของ collection นี้ — ลากเส้นจากจุดข้างการ์ดเพื่อเชื่อมมาที่ key
          </div>
          {soloKeys.map((f) => keyRow(f))}
          {/* กลุ่ม key ผสม — หลาย field รวมเป็น key เดียว แสดงเป็นกรอบกลุ่มเดียว สมาชิกแต่ละตัวมีจุดเชื่อมของตัวเอง (relation ยังเป็น field→field) */}
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
                    className={`nodrag rounded border px-1 text-[9px] ${
                      g.unique
                        ? "border-amber-600/60 text-amber-300"
                        : "border-slate-600 text-slate-400 hover:text-slate-200"
                    }`}
                    title={g.unique ? "ห้ามซ้ำ — compound unique index (กดเพื่อเปลี่ยนเป็น ซ้ำได้)" : "ซ้ำได้ — compound index ธรรมดา เพื่อค้นเร็ว (กดเพื่อเปลี่ยนเป็น ห้ามซ้ำ)"}
                    onClick={() => setGroupUnique(g, !g.unique)}
                  >
                    {g.unique ? "ห้ามซ้ำ" : "ซ้ำได้"}
                  </button>
                  <button
                    className="nodrag shrink-0 px-0.5 text-slate-500 hover:text-red-400"
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

      {/* รายการฟิลด์ — recursive ผ่าน FieldRow (nested document) */}
      <div className="divide-y divide-slate-700/60">
        {data.fields.map((f, fi) => (
          <div
            key={f.id}
            className="group px-3 py-1"
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex.current !== null) reorderField(dragIndex.current, fi);
              dragIndex.current = null;
            }}
          >
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
              dragIndexRef={dragIndex}
            />
          </div>
        ))}
      </div>

      <button
        className="nodrag w-full rounded-b-lg px-3 py-1.5 text-left text-xs text-sky-400 hover:bg-slate-700/50"
        onClick={addField}
      >
        ＋ เพิ่มฟิลด์
      </button>

      {/* popup ป้อนรายละเอียด — portal ไป body ให้หลุด transform ของ canvas */}
      {editing &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
            onClick={() => setEditing(null)}
          >
            <div
              className="mm-panel w-full max-w-md p-5 text-sm"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(null);
              }}
            >
              <h3 className="mb-3 font-semibold text-slate-100">
                {editing.kind === "collDesc"
                  ? "คำอธิบายคอลเลกชัน"
                  : editing.kind === "fieldDesc"
                    ? `คำอธิบายฟิลด์ "${editing.name}"`
                    : editing.kind === "keyGroup"
                      ? `key ผสม ของ "${editing.name}"`
                      : `enum / ค่าเริ่มต้น ของ "${editing.name}"`}
              </h3>

              {editing.kind === "keyGroup" ? (
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
                  onClick={() => setEditing(null)}
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
      {(data.refHandles ?? []).map((h, i) => (
        <span key={h}>
          <Handle type="target" position={Position.Left} id={`${h}-l`} className="!bg-amber-400" style={{ left: -10, top: 16 + i * 16 }} />
          <Handle type="target" position={Position.Right} id={`${h}-r`} className="!bg-amber-400" style={{ right: -10, top: 16 + i * 16 }} />
        </span>
      ))}
    </div>
  );
}

const nodeTypes = { collection: CollectionNodeView, crossref: CrossRefNodeView };

// ระยะเว้นจากจุดเชื่อมถึงปลายเส้น — react flow ตรึง marker ไว้ที่ refX=0 (ปลายแหลม = จุดปลาย path
// = ศูนย์กลาง handle พอดี) หัวลูกศรยาวแค่ ~7.5px จึงจมอยู่ในวงจุด (รัศมีที่มองเห็น ~8px) จนมองไม่เห็น
// ขยับปลาย path ออกก่อนวาดเอง = ลูกศรพ้นวงจุดและมีช่องว่างหายใจ (ลุคเดียวกับ Figma/Linear)
const EDGE_GAP_SOURCE = 17; // ฝั่งลูก — มีหัวลูกศร ต้องเว้นมากกว่า
const EDGE_GAP_TARGET = 12; // ฝั่งแม่ — ปลายเปล่า เว้นพอไม่ให้เส้นเสียบทับจุด
const LABEL_START = 44; // ระยะป้ายแรกจากปลายเส้นฝั่งลูก (px)
const LANE_STEP = 34; // เลื่อนป้ายเส้นถัดไปของการ์ดเดียวกันไปตามแนวเส้น
const LANE_SIDE = 15; // ระยะตั้งฉากจากเส้น สลับข้างทีละ lane (รวมสองฝั่ง = 30px > ความสูงป้าย)

/** ขยับจุดปลายออกจากการ์ดตามข้างที่ handle อยู่ */
function shiftEndpoint(x: number, y: number, pos: Position, d: number): [number, number] {
  if (pos === Position.Left) return [x - d, y];
  if (pos === Position.Right) return [x + d, y];
  if (pos === Position.Top) return [x, y - d];
  return [x, y + d];
}

/**
 * เส้น relation — bezier เหมือนเดิมทุกอย่าง ต่างแค่ (1) เว้นช่องว่างที่ปลายทั้งสองข้าง
 * (2) ป้ายชื่อ field ขยับมาอยู่ช่วงต้นเส้นฝั่งลูกแทนกึ่งกลาง เส้นที่วิ่งขนานกันจึงไม่กองป้ายทับกัน
 */
function RelEdgeView({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerStart, label, data,
}: EdgeProps) {
  const [sx, sy] = shiftEndpoint(sourceX, sourceY, sourcePosition, EDGE_GAP_SOURCE);
  const [tx, ty] = shiftEndpoint(targetX, targetY, targetPosition, EDGE_GAP_TARGET);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition,
    targetX: tx, targetY: ty, targetPosition,
  });
  // ป้ายเกาะช่วงต้นเส้นฝั่งลูก (~14% ของความยาว) ไม่ใช่กึ่งกลาง — กึ่งกลางของทุกเส้นที่วิ่ง
  // ระหว่างการ์ดคู่เดียวกันตกจุดเดียวกันหมด แต่ต้นเส้นคือแถว field ของตัวเอง ป้ายจึงแยกกันเอง
  // เส้นที่ออกจากการ์ดเดียวกันวิ่งขนานกัน ป้ายจึงกองทับ — เลื่อนป้ายไปตามแนวเส้นทีละ LANE_STEP
  // ใช้ระยะคงที่ (px) ไม่ใช่สัดส่วนความยาว เพราะเส้นสั้น ๆ (~150px) เหลื่อมแบบสัดส่วนได้ไม่ถึง
  // ความสูงป้าย (~26px) ก็ยังทับกันอยู่ดี
  const lane = typeof data?.lane === "number" ? data.lane : 0;
  const dx = labelX - sx;
  const dy = labelY - sy;
  const len = Math.hypot(dx, dy) || 1;
  const dist = Math.min(LABEL_START, len * 0.9); // เกาะช่วงต้นเส้น ไม่เลยปลาย
  const lx = sx + (dx / len) * dist;
  // เลื่อนแนวตั้งตรง ๆ ทีละ LANE_STEP — เลื่อนตามแนวเส้นไม่พอเพราะเส้นส่วนใหญ่เกือบแนวนอน
  // (ระยะแนวตั้งที่ได้น้อยกว่าความสูงป้าย) และยังไปหักล้างกับระยะระหว่างแถว field พอดี
  const ly = sy + (dy / len) * dist + lane * LANE_STEP;
  const dim = typeof style?.opacity === "number" && style.opacity < 0.5;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerStart={markerStart} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="mm-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, opacity: dim ? 0.25 : 1 }}
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
    setTheme(initial);
  }, []);
  useEffect(() => {
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
      if (Array.isArray(nodes) && Array.isArray(edges)) return { nodes, edges };
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
      list.push({
        name: typeof d.name === "string" && d.name ? d.name : fallback,
        nodes: d.nodes,
        edges: d.edges,
      });
    }
  } else if (Array.isArray(parsed?.nodes) && Array.isArray(parsed?.edges)) {
    list.push({
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : fallback,
      nodes: parsed.nodes,
      edges: parsed.edges,
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
  JSON.stringify({
    nodes: nodes.map((n) => ({ ...n, selected: undefined, dragging: undefined, measured: undefined })),
    edges: edges.map((e) => ({ ...e, selected: undefined, label: undefined })),
  });

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
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelEdge>([]);
  const [tabs, setTabs] = useState<DiagramMeta[]>([]);
  const [cur, setCur] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false); // ปุ่ม ? คู่มือบน canvas
  const [navOpen, setNavOpen] = useState(true); // แผงรายชื่อ collection ด้านซ้าย
  const [navQuery, setNavQuery] = useState("");
  const [codeTab, setCodeTab] = useState<CodeTab>("mongosh");
  const [saveError, setSaveError] = useState(false);
  const [externalEdit, setExternalEdit] = useState(false);
  const [aiNotice, setAiNotice] = useState(false); // toast "อัปเดตจาก AI แล้ว" หลัง auto refresh
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
  const { fitView, getViewport, setViewport, getInternalNode } = useReactFlow();

  // Ctrl+wheel / Ctrl+ลากซ้าย = scroll/แพนจออิสระ (wheel ธรรมดา = zoom, ลากซ้ายธรรมดา = กรอบเลือก เหมือนเดิม)
  // ทำเองที่ capture phase ของ root — d3-zoom/selection ของ React Flow ไม่ครอบ gesture นี้
  // หมายเหตุ: Ctrl+คลิก multi-select ถูกแย่งทับด้วย gesture นี้ (เลือกหลายอันใช้ลากกรอบได้อยู่แล้ว)
  useEffect(() => {
    const el = document.querySelector(".react-flow");
    if (!el) return;
    let panStart: { px: number; py: number; vx: number; vy: number } | null = null;

    const onWheel = (e: Event) => {
      const we = e as WheelEvent;
      if (!we.ctrlKey) return;
      we.preventDefault();
      we.stopImmediatePropagation();
      const vp = getViewport();
      setViewport({ x: vp.x - we.deltaX, y: vp.y - we.deltaY, zoom: vp.zoom });
    };
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

    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    el.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove, { capture: true });
    window.addEventListener("pointerup", onUp, { capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
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
    loadedId.current = id;
    // ล้าง history — undo ไม่ข้าม diagram
    past.current = [];
    future.current = [];
    present.current = serializeSnapshot(d.nodes, d.edges);
    skipHistory.current = false;
    syncHistSizes();
    // preserveView = auto refresh จาก server — ไม่ fitView กันจอเด้ง
    if (!preserveView) setTimeout(() => fitView({ padding: 0.2 }), 50);
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

  // PUT project ทั้งก้อนขึ้น server (fire-and-forget) — จำ rev/payload ไว้แยกการแก้ของตัวเอง
  const pushToServer = useCallback(
    async (payload: string) => {
      if (!serverOn.current) return;
      try {
        // แนบ rev ที่ถืออยู่ — ถ้ามีคนอื่น (แท็บอื่น/AI ผ่าน MCP) เขียนไปก่อน server จะตอบ 409
        // แทนที่จะทับงานเขาหายเงียบ
        const body = JSON.stringify({ ...JSON.parse(payload), expectedRev: knownRev.current });
        const res = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.status === 409) {
          conflict.current = true; // ระงับ auto refresh — ไม่งั้น poll รอบถัดไปทับการแก้ที่เพิ่งชนหายเงียบใน 3 วิ
          setExternalEdit(true); // แถบเตือน "มีคนแก้ไปแล้ว — refresh ก่อนแก้ต่อ"
          return;
        }
        if (res.ok) {
          const j = await res.json();
          if (typeof j.rev === "number") knownRev.current = j.rev;
          lastPayload.current = payload;
        }
      } catch {
        // server หลุด — localStorage ยังเก็บอยู่
      }
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
      diagramsMap.current = p.diagrams;
      setAllDiagrams(p.diagrams);
      lastPayload.current = JSON.stringify({ tabs: p.tabs, cur: p.cur, diagrams: p.diagrams });
      // mirror ลง localStorage ไว้เป็น offline cache
      trySave(INDEX_KEY, JSON.stringify({ tabs: p.tabs, cur: p.cur }));
      for (const t of p.tabs) {
        trySave(dataKey(t.id), JSON.stringify(p.diagrams[t.id] ?? { nodes: [], edges: [] }));
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

  // poll ทุก 3 วิ — rev บน server เปลี่ยนโดยไม่ใช่ของเรา = AI (MCP)/แท็บอื่นแก้ → auto refresh จาก server
  useEffect(() => {
    const t = setInterval(() => {
      if (!serverOn.current || knownRev.current === null) return;
      // มี conflict (409) ค้าง — local ถือการแก้ที่ server ยังไม่รับ ห้าม auto ทับเงียบ รอผู้ใช้เลือกที่แถบเตือน
      if (conflict.current) return;
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
          if (typeof p.rev !== "number" || p.rev === knownRev.current) return;
          knownRev.current = p.rev;
          // auto refresh — เอาของใหม่จาก server มาทับ (preserveView กันจอเด้ง)
          diagramsMap.current = p.diagrams;
          setAllDiagrams(p.diagrams);
          lastPayload.current = JSON.stringify({ tabs: p.tabs, cur: p.cur, diagrams: p.diagrams });
          setTabs(p.tabs);
          const id = p.diagrams[p.cur] ? p.cur : p.tabs[0]?.id;
          if (id) openDiagram(id, true);
          setAiNotice(true);
          setTimeout(() => setAiNotice(false), 3000);
        } catch {
          // เงียบ — รอบหน้าลองใหม่
        }
      })();
    }, 3000);
    return () => clearInterval(t);
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
      trySave(dataKey(cur), JSON.stringify({ nodes, edges }));
      diagramsMap.current[cur] = { nodes, edges };
      const payload = JSON.stringify({ tabs, cur, diagrams: diagramsMap.current });
      if (payload !== lastPayload.current) void pushToServer(payload);
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, cur, tabs, trySave, pushToServer]);

  const saveNow = useCallback(() => {
    if (cur) {
      trySave(dataKey(cur), JSON.stringify({ nodes, edges }));
      diagramsMap.current[cur] = { nodes, edges };
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

  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!confirm(`ลบ "${tab?.name}" ทิ้งถาวร?`)) return;
    localStorage.removeItem(dataKey(id));
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

  // double-click เส้น → วน reference/embed × cardinality 6 สถานะ
  const onEdgeDoubleClick = useCallback(
    (_: ReactMouseEvent, edge: RelEdge) => {
      setEdges((es) =>
        es.map((e) => {
          if (e.id !== edge.id) return e;
          const rel = e.data ?? {};
          const i = REL_CYCLE.findIndex(
            (c) => c.kind === (rel.kind ?? "reference") && c.cardinality === rel.cardinality
          );
          const next = REL_CYCLE[(i + 1) % REL_CYCLE.length];
          const embed = next.kind === "embed";
          return {
            ...e,
            data: { ...rel, ...next },
            animated: !embed,
            style: embed
              ? { stroke: "#64748b", strokeWidth: 1.5, strokeDasharray: "6 3", animationDirection: "reverse" }
              : { stroke: "#64748b", strokeWidth: 1.5, animationDirection: "reverse" },
          };
        })
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
      if (here.has(e.target)) continue;
      const hit = byTarget.get(e.target);
      if (hit) {
        if (e.targetHandle) hit.handles.add(e.targetHandle);
        continue;
      }
      for (const t of tabs) {
        if (t.id === cur) continue;
        const tn = allDiagrams[t.id]?.nodes.find((n) => n.id === e.target);
        if (!tn) continue;
        byTarget.set(e.target, {
          label: tn.data.label,
          tabId: t.id,
          tabName: t.name,
          handles: new Set(e.targetHandle ? [e.targetHandle] : []),
          src: curNodes.find((n) => n.id === e.source),
        });
        break;
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

  // label เส้น = ชื่อฟิลด์ต้นทาง (+ cardinality) + hover highlight — derive ล้วนตอน render
  const displayEdges = useMemo(() => {
    // ลำดับเส้นต่อการ์ดต้นทาง — เส้นที่ออกจากการ์ดเดียวกันวิ่งขนานกัน ป้ายจึงกองทับ ใช้เลื่อนแยก
    const laneOf = new Map<string, number>();
    const mapped = edges.map((e) => {
      const src = nodes.find((n) => n.id === e.source);
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
      const label = labelText || undefined;
      const el0 = e.label === label ? e : { ...e, label };
      const el =
        sh === e.sourceHandle && th === e.targetHandle
          ? el0
          : { ...el0, sourceHandle: sh, targetHandle: th };
      // edge เก่าที่ persist ไว้มี style/markerStart ของตัวเอง (ทำให้ defaultEdgeOptions ไม่ถูกใช้) — merge animationDirection + บังคับ marker orient ทุกเส้นตรงนี้ (วิ่ง/ชี้ แม่→ลูก)
      const base = { animationDirection: "reverse" as const, stroke: "#64748b", strokeWidth: 1.5, ...e.style };
      const marker: EdgeMarker = {
        type: MarkerType.ArrowClosed,
        color: "#38bdf8",
        width: 18,
        height: 18,
        ...(typeof e.markerStart === "object" ? e.markerStart : {}),
        orient: "auto-start-reverse",
      };
      // persisted edge มี type ของตัวเอง (ชนะ defaultEdgeOptions) — บังคับ "rel" ทุกเส้น ไม่งั้นเส้นเก่าไม่ได้ gap
      const lane = laneOf.get(e.source) ?? 0;
      laneOf.set(e.source, lane + 1);
      const elS = { ...el, type: "rel", style: base, markerStart: marker, data: { ...e.data, lane } };
      if (!hoveredId) return elS;
      return e.source === hoveredId || e.target === hoveredId
        ? { ...elS, style: { ...base, stroke: "#38bdf8", opacity: 1 } }
        : { ...elS, style: { ...base, opacity: 0.2 } };
    });
    return mapped;
  }, [edges, nodes, crossNodes, hoveredId]);

  // ตรวจโมเดลของ diagram ที่เปิดอยู่ (allNodes = node จริงทุกแท็บ เพื่อ resolve ปลายทางของเส้นข้ามแท็บ)
  // ห้ามใช้ crossNodes แทน — node เสมือนมี fields ว่าง ทำให้ field ปลายทาง resolve ไม่ได้
  // (fk-type-mismatch ข้าม tab ไม่เคยทำงาน และ dangling-relation จะ false positive)
  const lintIssues = useMemo(
    () => lintModel(nodes as unknown as GenNode[], edges as unknown as GenEdge[], [
      ...(nodes as unknown as GenNode[]),
      ...Object.entries(allDiagrams)
        .filter(([id]) => id !== cur)
        .flatMap(([, d]) => d.nodes as unknown as GenNode[]),
    ]),
    [nodes, edges, allDiagrams, cur],
  );

  // คีย์ลัด: Ctrl+D ทำซ้ำ node ที่เลือก, Ctrl+K โฟกัสค้นหา, Esc ปิดค้นหา/modal
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setQuery("");
        searchInput.current?.blur();
        setCodeOpen(false);
        return;
      }
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k === "d") {
        const sel = nodes.find((n) => n.selected);
        if (!sel) return;
        ev.preventDefault();
        setNodes((ns) => [...ns, cloneCollection(sel)]);
      } else if (k === "k") {
        ev.preventDefault();
        searchInput.current?.focus();
      } else if (k === "z") {
        // โฟกัส input/textarea/select ถูก return ไปก่อนแล้ว → Ctrl+Z ในช่องพิมพ์ = native undo
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
  }, [nodes, setNodes, undo, redo]);

  // ค้นหาจากชื่อคอลเลกชัน + ชื่อฟิลด์
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter(
      (n) =>
        n.data.label.toLowerCase().includes(q) ||
        n.data.fields.some((f) => f.name.toLowerCase().includes(q))
    );
  }, [nodes, query]);

  const focusNode = (nid: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nid })));
    setQuery("");
    fitView({ nodes: [{ id: nid }], duration: 300, maxZoom: 1.2 });
  };

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

  const addCollection = () =>
    setNodes((ns) => {
      // วางใต้การ์ดที่อยู่ล่างสุดตามความสูงจริง — สูตร index*40 เดิมโดนการ์ดสูงๆ ทับจนมองไม่เห็น/กดไม่ได้
      const bottom = ns.reduce((m, n) => Math.max(m, n.position.y + sizeOf(n).h), 80);
      return [
        ...ns,
        {
          id: uid(),
          type: "collection",
          position: { x: 120, y: bottom + 40 },
          data: {
            label: `collection_${ns.length + 1}`,
            fields: [{ id: uid(), name: "_id", type: "ObjectId" as FieldType, required: true }],
          },
        },
      ];
    });

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

    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 60);
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
    downloadJson(
      { app: "mongomodel", version: 1, name, nodes, edges },
      `${name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`
    );
  };

  // สำรองทุกแท็บเป็นไฟล์เดียว
  const backupAll = () => {
    saveNow();
    const diagrams = tabs.map((t) => {
      const d = t.id === cur ? { nodes, edges } : loadDiagram(t.id);
      return { name: t.name, nodes: d.nodes, edges: d.edges };
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
        trySave(dataKey(id), JSON.stringify({ nodes: d.nodes, edges: d.edges }));
        diagramsMap.current[id] = { nodes: d.nodes, edges: d.edges };
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
          ? toTypeScript(gn, ge)
          : codeTab === "Markdown"
            ? toMarkdown(gn, ge, allGn)
            : codeTab === "Wiki"
              ? Object.entries(toWiki(gn, ge, project, allGn))
                  .map(([f, c]) => `### 📄 ${f}\n\n${c}`)
                  .join("\n\n---\n\n")
              : codeTab === "ตัวอย่าง"
                ? gn.map((n) => `// ${n.data.label}\n` + toSampleDoc(n)).join("\n\n")
                : JSON.stringify({ nodes, edges }, null, 2);
  }, [codeOpen, codeTab, nodes, edges, project, allDiagrams, cur]);

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      {/* แถบเครื่องมือ */}
      <header className="mm-bar flex items-center gap-3 px-4 py-2.5">
        <button
          className="mm-btn border-transparent bg-transparent px-2"
          title="กลับไปหน้าเลือกโปรเจกต์"
          onClick={onExit}
        >
          ←
        </button>
        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.5)]" />
        <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-slate-50">MongoModel</h1>
        <span className="max-w-48 shrink-0 truncate rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-300">
          {project}
        </span>
        <span className="hidden shrink-0 whitespace-nowrap text-xs text-slate-500 xl:block">
          ออกแบบโครงสร้างข้อมูล MongoDB
        </span>
        <div className="mm-toolbar ml-auto flex min-w-0 items-center gap-2 overflow-x-auto">
          {/* ค้นหา + ซูมไปหา */}
          <div className="relative">
            <input
              ref={searchInput}
              className="mm-input w-44"
              placeholder="🔍 ค้นหา (Ctrl+K)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() !== "" && (
              <div className="mm-panel absolute left-0 top-full z-50 mt-1.5 max-h-64 w-64 overflow-auto">
                {searchResults.length ? (
                  searchResults.map((n) => (
                    <button
                      key={n.id}
                      className="block w-full px-3 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800"
                      onClick={() => focusNode(n.id)}
                    >
                      <span className="font-medium">{n.data.label}</span>
                      <span className="ml-2 text-xs text-slate-500">{n.data.fields.length} ฟิลด์</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-1.5 text-sm text-slate-500">ไม่พบ</div>
                )}
              </div>
            )}
          </div>
          <button
            className="mm-btn px-2.5"
            title="ย้อนกลับ (Ctrl+Z)"
            disabled={!histSizes.past}
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
            className="mm-btn mm-btn-accent"
            onClick={addCollection}
          >
            ＋ เพิ่มคอลเลกชัน
          </button>
          <button
            className="mm-btn"
            title="จัดเรียง node อัตโนมัติ ไม่ให้ทับกัน"
            onClick={() => void autoLayout()}
          >
            ▦ จัดผัง
          </button>
          <button
            className="mm-btn mm-btn-primary"
            onClick={() => setCodeOpen(true)}
          >
            ⚙️ สร้างโค้ด
          </button>
          <button
            className={`mm-btn ${lintIssues.length ? "border-amber-500/40 text-amber-300" : ""}`}
            title="ตรวจโมเดลด้วยกฎที่เครื่องจับได้ (ฟิลด์เงิน, unique, FK, tenant scope, array)"
            onClick={() => setLintOpen(true)}
          >
            🩺 ตรวจ{lintIssues.length > 0 ? ` (${lintIssues.length})` : ""}
          </button>
          <button
            className={`mm-btn ${wikiOpen ? "mm-btn-on" : ""}`}
            title="เปิด/ปิด wiki แบบ Obsidian ข้าง canvas (หน้าเดียวกัน)"
            onClick={() => onShowWiki(project)}
          >
            📖 Wiki
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            title="นำเข้าไฟล์ JSON เพิ่มเป็นแท็บใหม่ในโปรเจกต์นี้ (ไม่ทับงานเดิม)"
            onClick={() => fileInput.current?.click()}
          >
            📥 <span className="hidden 2xl:inline">นำเข้า</span>
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            title="ส่งออก project นี้เป็นไฟล์ JSON"
            onClick={exportJson}
          >
            📤 <span className="hidden 2xl:inline">ส่งออก</span>
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            title="สำรองทุก project เป็นไฟล์เดียว"
            onClick={backupAll}
          >
            💾 <span className="hidden 2xl:inline">สำรองทั้งหมด</span>
          </button>
          <ThemeButton theme={theme} onToggle={onToggleTheme} />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = "";
          }}
        />
      </header>

      {/* toast — auto refresh หลัง AI/แหล่งอื่นแก้ project */}
      {aiNotice && (
        <div className="border-b border-emerald-900 bg-emerald-950 px-4 py-1.5 text-xs text-emerald-300">
          🔄 อัปเดตจาก AI (MCP) หรือแหล่งอื่นแล้ว
        </div>
      )}

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
            diagram อาจถูกแก้จาก AI (ผ่าน MCP) หรือแท็บอื่น — โหลดจาก server ก่อนแก้ต่อเพื่อกันงานทับกัน
          </span>
          {/* การแก้ที่ชน (409) ไม่ถูก auto ทับ — ทับได้เฉพาะเมื่อผู้ใช้กดปุ่มนี้เอง */}
          <button
            className="shrink-0 rounded border border-yellow-700 px-2 py-0.5 hover:text-yellow-100"
            title="โหลดข้อมูลล่าสุดจาก server มาแทน (การแก้ในเครื่องที่ชนกันจะถูกทิ้ง)"
            onClick={() => {
              conflict.current = false;
              setExternalEdit(false);
              void bootstrap();
            }}
          >
            🔄 โหลดจาก server
          </button>
          <button
            className="shrink-0 hover:text-yellow-100"
            title="ปิดแถบเตือน"
            onClick={() => setExternalEdit(false)}
          >
            ✕
          </button>
        </div>
      )}

      {/* แท็บ diagram — save/load ในเครื่อง */}
      <div className="mm-bar flex items-end gap-1 px-3 pt-2">
        {tabs.map((t, ti) => (
          <div
            key={t.id}
            className={`mm-tab group flex cursor-pointer items-center gap-1.5 px-3.5 py-2 text-sm ${t.id === cur ? "mm-tab-active" : ""}`}
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
                value={t.name}
                onChange={(e) => renameTab(t.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="max-w-32 truncate">{t.name}</span>
            )}
            <button
              className="text-slate-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
              title="ลบ diagram นี้"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
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
      <div className="flex-1">
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
          onNodeClick={(_, n) => {
            // stub ปลายทางเส้นข้าม tab — กดแล้วข้ามไป tab นั้น
            if ((n.type as string) === "crossref" && n.data.crossTabId) openDiagram(n.data.crossTabId);
          }}
          onBeforeDelete={async ({ nodes: del }) => {
            // คอลเลกชันที่มีงานจริง (>1 ฟิลด์) ต้อง confirm ก่อนลบ — ครอบทั้งปุ่ม ✕ และ Delete key
            const big = del.find((n) => n.data.fields.length > 1);
            return !big || window.confirm(`ลบคอลเลกชัน "${big.data.label}"?`);
          }}
          onNodeMouseEnter={(_, n) => setHoveredId(n.id)}
          onNodeMouseLeave={() => setHoveredId(null)}
          deleteKeyCode={["Delete", "Backspace"]}
          snapToGrid
          snapGrid={[20, 20]}
          selectionOnDrag
          panOnDrag={[1, 2]}
          // 48 (ค่าเดิม) กว้างกว่าระยะระหว่าง handle เอง — source กับ target ของ field เดียวกันห่างแค่ 14px
          // และแถวถัดไปห่าง ~39px จึงคว้า handle ตัวอื่นแทนตัวที่กด (เส้นออกผิดจุด) 10 = แคบกว่าครึ่งของ 14
          connectionRadius={10}
          defaultEdgeOptions={{
            type: "rel",
            animated: true,
            // dash animation วิ่งตาม path (ลูก→แม่) ผิดทิศความหมาย — inline animationDirection reverse ให้วิ่งแม่→ลูก (inline ชนะ animation shorthand จาก stylesheet เสมอ ไม่พึ่ง globals.css; onEdgeDoubleClick ต้องใส่ค่านี้ทุก style ด้วย)
            style: { stroke: "#64748b", strokeWidth: 1.5, animationDirection: "reverse" },
            // ทิศลูกศร: แม่(master/key=target) → ลูก(FK=source) — markerStart อยู่ปลายฝั่งลูก + orient auto-start-reverse ให้หัวลูกศรชี้เข้าหาลูก (default auto จะชี้ออก = กลับทิศ)
            markerStart: { type: MarkerType.ArrowClosed, color: "#38bdf8", width: 20, height: 20, orient: "auto-start-reverse" },
          }}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} color="#1e293b" />
          <Controls />
          <MiniMap nodeColor="#1e40af" maskColor="rgba(2,6,23,0.75)" pannable zoomable />
          {/* แผงรายชื่อ collection ด้านซ้าย — กดแล้วกระโดดไปหา node เลย */}
          <Panel position="top-left">
            <div className="mm-panel w-52 overflow-hidden">
              <button
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-semibold text-slate-300 hover:text-slate-100"
                title="พับ/ขยายรายชื่อ collection"
                onClick={() => setNavOpen((v) => !v)}
              >
                <span className={`inline-block text-[9px] transition-transform ${navOpen ? "rotate-90" : ""}`}>
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
                          <div className="truncate text-[11px]">
                            {n.data.label}
                            <span className="ml-1.5 text-[9px] text-slate-600">{n.data.fields.length}</span>
                          </div>
                          {n.data.description && (
                            <div className="truncate text-[9px] text-slate-500" title={n.data.description}>
                              {n.data.description}
                            </div>
                          )}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          </Panel>
          {/* ปุ่มคู่มือ — แถบ hint ด้านล่างถูกย้ายมาอยู่ตรงนี้ */}
          <Panel position="bottom-right">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-800 bg-slate-900/90 text-xs text-slate-400 shadow hover:text-slate-200"
              title="คู่มือ / คีย์ลัด"
              onClick={() => setHelpOpen((v) => !v)}
            >
              ?
            </button>
          </Panel>
          {helpOpen && (
            <Panel
              position="bottom-right"
              className="mb-9 w-72 rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs leading-relaxed text-slate-300 shadow-2xl"
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
                <li>• ลากพื้นว่าง = กรอบเลือกหลายอัน</li>
                <li>• เมาส์กลาง/ขวาลาก = เลื่อนจอ</li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Ctrl</kbd>+ลาก /{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl</kbd>+wheel = เลื่อนจออิสระ
                </li>
                <li>• wheel = ซูม</li>
                <li>• ดับเบิลคลิกเส้น = เปลี่ยนชนิด/ความสัมพันธ์</li>
                <li>
                  • <kbd className="rounded bg-slate-800 px-1">Ctrl+D</kbd> ทำซ้ำ ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl+K</kbd> ค้นหา ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Ctrl+Z</kbd> ย้อน ·{" "}
                  <kbd className="rounded bg-slate-800 px-1">Delete</kbd> ลบ
                </li>
              </ul>
            </Panel>
          )}
        </ReactFlow>
      </div>

      {/* ศูนย์ส่งออกโค้ด */}
      {lintOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setLintOpen(false)}
        >
          <div
            className="mm-panel flex h-full max-h-[70vh] w-full max-w-3xl flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-semibold text-slate-200">🩺 ตรวจโมเดล</span>
              <span className="text-xs text-slate-500">
                {lintIssues.length === 0
                  ? "ไม่พบปัญหา"
                  : `${lintIssues.filter((i) => i.level === "error").length} ต้องแก้ · ${lintIssues.filter((i) => i.level === "warn").length} ควรทบทวน`}
              </span>
              <button className="mm-btn ml-auto px-2" onClick={() => setLintOpen(false)}>
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {lintIssues.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  ผังนี้ผ่านกฎทั้งหมด 👍
                </div>
              ) : (
                <table className="w-full text-xs">
                  <tbody>
                    {[...lintIssues]
                      .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
                      .map((i, n) => (
                        <tr key={n} className="border-b border-white/5 align-top">
                          <td className="whitespace-nowrap py-1.5 pr-2">
                            <span className={i.level === "error" ? "text-red-400" : "text-amber-400"}>
                              {i.level === "error" ? "●" : "○"}
                            </span>
                          </td>
                          <td className="whitespace-nowrap py-1.5 pr-3 font-medium text-slate-200">
                            {i.collection}
                            {i.field ? <span className="text-slate-400">.{i.field}</span> : null}
                          </td>
                          <td className="py-1.5 pr-3 text-slate-300">{i.message}</td>
                          <td className="whitespace-nowrap py-1.5 text-[10px] text-slate-500">{i.rule}</td>
                        </tr>
                      ))}
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
            className="flex h-full max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
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
                <button
                  className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                  onClick={() => navigator.clipboard.writeText(codeText)}
                >
                  📋 คัดลอก
                </button>
                <button
                  className="rounded-md px-2 py-1 text-slate-500 hover:text-slate-200"
                  title="ปิด"
                  onClick={() => setCodeOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs leading-relaxed text-slate-300">{codeText}</pre>
          </div>
        </div>
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
      setList(projects);
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

  const del = async (name: string) => {
    if (!confirm(`ลบโปรเจกต์ "${name}" ถาวร? (ทุก diagram ในนั้นหายหมด)`)) return;
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
        <div className="mb-6 flex items-center gap-3">
          <span className="h-3 w-3 rounded-full bg-emerald-500" />
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">MongoModel</h1>
          <span className="text-xs text-slate-500">ออกแบบโครงสร้างข้อมูล MongoDB</span>
          <div className="ml-auto">
            <ThemeButton theme={theme} onToggle={onToggleTheme} />
          </div>
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
                      className="text-slate-600 hover:text-sky-300"
                      title="แสดงแบบ Obsidian (Wiki)"
                      onClick={() => onShowWiki(p.name)}
                    >
                      🌐
                    </button>
                    <button
                      className="text-slate-600 hover:text-slate-300"
                      title="เปลี่ยนชื่อ"
                      onClick={() => {
                        setRenaming(p.name);
                        setRenameText(p.name);
                      }}
                    >
                      ✏️
                    </button>
                    <button
                      className="text-slate-600 hover:text-red-400"
                      title="ลบโปรเจกต์"
                      onClick={() => void del(p.name)}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-6 text-xs text-slate-600">
              AI อื่นเชื่อมผ่าน MCP ได้ที่{" "}
              <code className="text-slate-400">http://localhost:3100/mcp</code> — ทุก tool
              ระบุชื่อโปรเจกต์เสมอ ทำได้หลายโปรเจกต์พร้อมกัน
            </div>
          </>
        )}
      </div>
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
