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
  NodeResizeControl,
  ResizeControlVariant,
  ReactFlowProvider,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
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
  toWiki,
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
  | { kind: "enumDefault"; fid: string; name: string; enumText: string; def: string };

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
    targetHandle: "ref",
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
  dragIndexRef,
}: FieldRowProps) {
  const top = depth === 0;
  const nest = canNest(f);
  const nameErr =
    f.name.trim() === ""
      ? "ชื่อว่าง"
      : siblings.some((o) => o.id !== f.id && o.name === f.name)
        ? "ชื่อซ้ำ"
        : "";
  return (
    <>
      <div className="relative flex items-center gap-1.5">
        {top && <Handle type="target" position={Position.Left} id={`${f.id}-t`} />}
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
        {/* _id = primary key ของ MongoDB — first-wins ตรงกับ codegen (เฉพาะ top-level) */}
        <span className="w-4 shrink-0 text-center text-xs">
          {isPK ? (
            <span title="Primary key">🔑</span>
          ) : (
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
          className="nodrag rounded bg-slate-700 px-1 py-0.5 text-[11px] text-slate-300 outline-none"
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
        {/* actions รอง — โผล่ตอน hover แถว กัน node รก (enum/unique เฉพาะ top-level) */}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] ${
              f.enum?.length || f.default != null
                ? "text-sky-300"
                : "text-slate-500 hidden group-hover:inline-block hover:text-slate-300"
            }`}
            title="ตั้ง enum / ค่าเริ่มต้น"
            onClick={() => onEditEnumDefault(f)}
          >
            ◇
          </button>
        )}
        {top && (
          <button
            className={`nodrag shrink-0 text-[10px] font-bold ${
              f.unique
                ? "text-amber-300"
                : "text-slate-600 hidden group-hover:inline-block hover:text-slate-400"
            }`}
            title="unique index"
            onClick={() => onPatch(f.id, { unique: !f.unique })}
          >
            U
          </button>
        )}
        <button
          className={`nodrag shrink-0 text-[10px] ${f.description ? "opacity-90" : "opacity-25 hover:opacity-70"}`}
          title={f.description ? "แก้คำอธิบายฟิลด์" : "เพิ่มคำอธิบายฟิลด์"}
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
        {top && <Handle type="source" position={Position.Right} id={`${f.id}-s`} />}
      </div>
      {/* ชนิดสมาชิก Array — บรรทัด 2 เพื่อไม่บีบชื่อฟิลด์ */}
      {f.type === "Array" && (
        <div className="mt-0.5 flex items-center gap-1.5 pl-[22px] pr-1 text-[10px] text-slate-400/90">
          <span>ของ</span>
          <select
            className="nodrag rounded bg-slate-700 px-1 py-0.5 text-[10px] text-slate-300 outline-none"
            title="ชนิดสมาชิกของ Array"
            value={f.of ?? "String"}
            onChange={(e) => onPatch(f.id, { of: e.target.value as FieldType })}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
      )}
      {/* คำอธิบายฟิลด์ — แสดง inline ถ้ามี */}
      {f.description && (
        <div className="mt-0.5 pl-[22px] pr-1 text-[10px] leading-snug text-slate-400/90 whitespace-pre-wrap break-words">
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
  const { updateNodeData, deleteElements, setEdges, getNode, addNodes } =
    useReactFlow<CollectionNode>();
  const [editingLabel, setEditingLabel] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
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

  const patchField = (fid: string, patch: Partial<Field>) =>
    updateNodeData(id, { fields: updateFieldInTree(data.fields, fid, patch) });

  const removeField = (fid: string) => {
    updateNodeData(id, { fields: removeFieldInTree(data.fields, fid) });
    // ลบเส้นเชื่อมที่ค้างอยู่กับฟิลด์นี้
    setEdges((es) =>
      es.filter(
        (e) =>
          !(e.source === id && e.sourceHandle === `${fid}-s`) &&
          !(e.target === id && e.targetHandle === `${fid}-t`)
      )
    );
  };

  const addField = () =>
    updateNodeData(id, {
      fields: [
        ...data.fields,
        { id: uid(), name: "field_" + (data.fields.length + 1), type: "String" as FieldType, required: false },
      ],
    });

  const addChild = (parentId: string) =>
    updateNodeData(id, {
      fields: addChildInTree(data.fields, parentId, {
        id: uid(),
        name: "field",
        type: "String" as FieldType,
        required: false,
      }),
    });

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

  // เปิด popup ป้อนรายละเอียด (แทน window.prompt)
  const editDescription = () =>
    setEditing({ kind: "collDesc", text: data.description ?? "" });
  const editFieldDescription = (f: Field) =>
    setEditing({ kind: "fieldDesc", fid: f.id, name: f.name, text: f.description ?? "" });
  const editEnumDefault = (f: Field) =>
    setEditing({
      kind: "enumDefault",
      fid: f.id,
      name: f.name,
      enumText: f.enum?.join(", ") ?? "",
      def: f.default ?? "",
    });

  // บันทึกค่าจาก popup
  const saveEditing = () => {
    if (!editing) return;
    if (editing.kind === "collDesc") {
      updateNodeData(id, { description: editing.text.trim() || undefined });
    } else if (editing.kind === "fieldDesc") {
      patchField(editing.fid, { description: editing.text.trim() || undefined });
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
      className={`w-full min-w-[16rem] rounded-lg border bg-slate-800 text-xs shadow-xl shadow-black/30 ${
        selected ? "border-sky-400" : "border-slate-600"
      }`}
    >
      {/* ลากขอบขวาเพื่อปรับความกว้าง (สูง auto, width เก็บถาวรใน node) */}
      <NodeResizeControl
        variant={ResizeControlVariant.Line}
        position="right"
        minWidth={256}
        maxWidth={760}
        color="#38bdf8"
      />

      {/* หัวคอลเลกชัน */}
      <div
        className={`relative flex items-center gap-2 rounded-t-lg bg-blue-900 px-3 py-1.5 border-b border-slate-600 ${
          labelErr ? "ring-1 ring-red-500" : ""
        }`}
        title={labelErr || undefined}
      >
        <Handle type="target" position={Position.Left} id="ref" className="!bg-amber-400" />
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
          className={`nodrag shrink-0 text-xs ${data.description ? "opacity-100" : "opacity-30 hover:opacity-70"}`}
          title={data.description || "เพิ่มคำอธิบายคอลเลกชัน"}
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
              className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm shadow-2xl"
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
                    : `enum / ค่าเริ่มต้น ของ "${editing.name}"`}
              </h3>

              {editing.kind === "enumDefault" ? (
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
                <textarea
                  autoFocus
                  rows={4}
                  className="w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
                  placeholder="พิมพ์รายละเอียดที่นี่…"
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveEditing();
                  }}
                />
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

const nodeTypes = { collection: CollectionNodeView };

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

const CODE_TABS = ["mongosh", "Mongoose", "TypeScript", "Markdown", "Wiki", "ตัวอย่าง", "JSON"] as const;
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
}: {
  project: string; // ชื่อ project บน server — source of truth
  offline: boolean; // true = โหมดออฟไลน์ (localStorage ล้วน ไม่มีระบบ project)
  onExit: () => void; // กลับไปหน้าเลือกโปรเจกต์
  onShowWiki: (name: string) => void; // toggle wiki ข้าง canvas (หน้าเดียวกัน)
  wikiOpen: boolean; // wiki ของโปรเจกต์นี้เปิดอยู่ไหม (ไฮไลต์ปุ่ม)
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CollectionNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelEdge>([]);
  const [tabs, setTabs] = useState<DiagramMeta[]>([]);
  const [cur, setCur] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeTab, setCodeTab] = useState<CodeTab>("mongosh");
  const [saveError, setSaveError] = useState(false);
  const [externalEdit, setExternalEdit] = useState(false);
  const [aiNotice, setAiNotice] = useState(false); // toast "อัปเดตจาก AI แล้ว" หลัง auto refresh
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadedId = useRef(""); // diagram id ที่โหลดเข้า state แล้ว (กัน autosave ก่อนโหลด)
  // sync กับ server (/api/project) — server เป็น source of truth ที่ AI (MCP) เห็นด้วย
  const diagramsMap = useRef<Record<string, { nodes: CollectionNode[]; edges: RelEdge[] }>>({});
  const knownRev = useRef<number | null>(null); // rev ล่าสุดที่ UI รู้ — ต่างจาก server = มีคนอื่นแก้
  const lastPayload = useRef(""); // payload ล่าสุดที่ server มี — กัน autosave ยิง PUT ซ้ำตอน refresh/โหลด (ไม่งั้น rev ไถลและของที่ AI ลบเด้งกลับ)
  const serverOn = useRef(false); // bootstrap ต่อ server ได้ไหม — ไม่ได้ = โหมด offline (localStorage ล้วน)
  const { fitView } = useReactFlow();

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
        const res = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
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
      void (async () => {
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(project)}`);
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

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return; // ไม่เชื่อมตัวเอง
      // 1 ฟิลด์ = 1 ref — ลากซ้ำจาก handle เดิม = ย้าย reference (ตรง buildRefMap last-write-wins)
      setEdges((es) =>
        addEdge(c, es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle)))
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
              ? { stroke: "#64748b", strokeWidth: 1.5, strokeDasharray: "6 3" }
              : { stroke: "#64748b", strokeWidth: 1.5 },
          };
        })
      );
    },
    [setEdges]
  );

  // label เส้น = ชื่อฟิลด์ต้นทาง (+ cardinality) + hover highlight — derive ล้วนตอน render
  // (เดิมเป็น effect ที่ sync setEdges ทุกรอบ → cascading render ทุกครั้งที่ undo/redo)
  const displayEdges = useMemo(() => {
    return edges.map((e) => {
      const src = nodes.find((n) => n.id === e.source);
      const fid = e.sourceHandle?.replace(/-s$/, "");
      const name = src?.data.fields.find((f) => f.id === fid)?.name ?? "";
      const card = e.data?.cardinality ? CARD_LABEL[e.data.cardinality] : "";
      const label = name && card ? `${name} · ${card}` : name || card || undefined;
      const el = e.label === label ? e : { ...e, label };
      if (!hoveredId) return el;
      const base = e.style ?? { stroke: "#64748b", strokeWidth: 1.5 };
      return e.source === hoveredId || e.target === hoveredId
        ? { ...el, style: { ...base, stroke: "#38bdf8", opacity: 1 } }
        : { ...el, style: { ...base, opacity: 0.2 } };
    });
  }, [edges, nodes, hoveredId]);

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

  const addCollection = () =>
    setNodes((ns) => [
      ...ns,
      {
        id: uid(),
        type: "collection",
        position: { x: 120 + ns.length * 40, y: 120 + ns.length * 40 },
        data: {
          label: `collection_${ns.length + 1}`,
          fields: [{ id: uid(), name: "_id", type: "ObjectId" as FieldType, required: true }],
        },
      },
    ]);

  // จัดผังอัตโนมัติ — เรียงเป็นคอลัมน์ตามระดับการอ้างอิง (master ซ้าย → transaction ขวา),
  // y เรียงตามความสูงจริงของ node เพื่อไม่ทับกัน
  const autoLayout = () => {
    // reference edge เท่านั้นใช้เป็นทิศ (embed/self-ref ไม่นับ กัน cycle)
    const outByNode = new Map<string, string[]>();
    edges.forEach((e) => {
      if (e.data?.kind === "embed" || e.source === e.target) return;
      const arr = outByNode.get(e.source) ?? [];
      arr.push(e.target);
      outByNode.set(e.source, arr);
    });
    const cache = new Map<string, number>();
    const depth = (id: string, seen: Set<string>): number => {
      const c = cache.get(id);
      if (c !== undefined) return c;
      if (seen.has(id)) return 0; // กัน cycle
      seen.add(id);
      const outs = outByNode.get(id) ?? [];
      const d = outs.length ? 1 + Math.max(...outs.map((t) => depth(t, seen))) : 0;
      seen.delete(id);
      cache.set(id, d);
      return d;
    };

    const GAP_X = 80,
      GAP_Y = 40,
      X0 = 40,
      Y0 = 40;
    const byDepth = new Map<number, CollectionNode[]>();
    nodes.forEach((n) => {
      const d = depth(n.id, new Set());
      const arr = byDepth.get(d) ?? [];
      arr.push(n);
      byDepth.set(d, arr);
    });

    const pos = new Map<string, { x: number; y: number }>();
    let x = X0;
    [...byDepth.keys()]
      .sort((a, b) => a - b)
      .forEach((d) => {
        const arr = byDepth.get(d)!;
        let y = Y0;
        let colW = 0;
        arr.forEach((n) => {
          pos.set(n.id, { x, y });
          y += (n.measured?.height ?? 240) + GAP_Y;
          colW = Math.max(colW, n.measured?.width ?? n.width ?? 288);
        });
        x += colW + GAP_X;
      });

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
    const ge: GenEdge[] = edges.map((e) => ({
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      data: e.data,
    }));
    return codeTab === "mongosh"
      ? toMongosh(gn, ge)
      : codeTab === "Mongoose"
        ? toMongoose(gn, ge)
        : codeTab === "TypeScript"
          ? toTypeScript(gn, ge)
          : codeTab === "Markdown"
            ? toMarkdown(gn, ge)
            : codeTab === "Wiki"
              ? Object.entries(toWiki(gn, ge, project))
                  .map(([f, c]) => `### 📄 ${f}\n\n${c}`)
                  .join("\n\n---\n\n")
              : codeTab === "ตัวอย่าง"
                ? gn.map((n) => `// ${n.data.label}\n` + toSampleDoc(n)).join("\n\n")
                : JSON.stringify({ nodes, edges }, null, 2);
  }, [codeOpen, codeTab, nodes, edges, project]);

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      {/* แถบเครื่องมือ */}
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2">
        <button
          className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          title="กลับไปหน้าเลือกโปรเจกต์"
          onClick={onExit}
        >
          ←
        </button>
        <span className="h-3 w-3 rounded-full bg-emerald-500" />
        <h1 className="font-bold text-slate-100">MongoModel</h1>
        <span className="max-w-48 truncate rounded-full border border-sky-800 bg-sky-950 px-2.5 py-0.5 text-xs text-sky-300">
          {project}
        </span>
        <span className="hidden text-xs text-slate-500 sm:block">
          ออกแบบโครงสร้างข้อมูล MongoDB
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* ค้นหา + ซูมไปหา */}
          <div className="relative">
            <input
              ref={searchInput}
              className="w-44 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-sky-500"
              placeholder="🔍 ค้นหา (Ctrl+K)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() !== "" && (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-64 overflow-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
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
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="ย้อนกลับ (Ctrl+Z)"
            disabled={!histSizes.past}
            onClick={undo}
          >
            ↶
          </button>
          <button
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
            title="ทำซ้ำ (Ctrl+Y / Ctrl+Shift+Z)"
            disabled={!histSizes.future}
            onClick={redo}
          >
            ↷
          </button>
          <button
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            onClick={addCollection}
          >
            ＋ เพิ่มคอลเลกชัน
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            title="จัดเรียง node อัตโนมัติ ไม่ให้ทับกัน"
            onClick={autoLayout}
          >
            ▦ จัดผัง
          </button>
          <button
            className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
            onClick={() => setCodeOpen(true)}
          >
            ⚙️ สร้างโค้ด
          </button>
          <button
            className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              wikiOpen
                ? "border-sky-600 bg-sky-950 text-sky-300"
                : "border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
            title="เปิด/ปิด wiki แบบ Obsidian ข้าง canvas (หน้าเดียวกัน)"
            onClick={() => onShowWiki(project)}
          >
            📖 Wiki
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            onClick={() => fileInput.current?.click()}
          >
            📥 นำเข้า
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            onClick={exportJson}
          >
            📤 ส่งออก
          </button>
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            onClick={backupAll}
          >
            💾 สำรองทั้งหมด
          </button>
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
            diagram อาจถูกแก้จาก AI (ผ่าน MCP) หรือแท็บอื่น — refresh ก่อนแก้ต่อเพื่อกันงานทับกัน
          </span>
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
      <div className="flex items-end gap-1 border-b border-slate-800 bg-slate-900 px-3 pt-1.5">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`group flex cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1.5 text-sm ${
              t.id === cur
                ? "border-slate-700 bg-slate-950 text-slate-100"
                : "border-transparent bg-slate-800/60 text-slate-400 hover:bg-slate-800"
            }`}
            onClick={() => switchTab(t.id)}
          >
            <span className="text-xs opacity-60">▦</span>
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
          colorMode="dark"
          nodes={nodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
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
          defaultEdgeOptions={{
            type: "default",
            animated: true,
            style: { stroke: "#64748b", strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#64748b" },
            labelStyle: { fill: "#94a3b8", fontSize: 11 },
            labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
            labelBgPadding: [4, 2],
            labelBgBorderRadius: 4,
          }}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} color="#1e293b" />
          <Controls />
          <MiniMap nodeColor="#1e40af" maskColor="rgba(2,6,23,0.75)" pannable zoomable />
          <Panel
            position="bottom-center"
            className="rounded-full bg-slate-900/90 px-4 py-1.5 text-xs text-slate-400 shadow border border-slate-800"
          >
            ลากจุดขวาของฟิลด์ไปคอลเลกชันอื่นเพื่อเชื่อม • ลากพื้นว่าง = เลือกหลายอัน
            (เมาส์กลาง/ขวา = เลื่อน) • ดับเบิลคลิกเส้น = เปลี่ยนชนิด/ความสัมพันธ์ • Ctrl+D
            ทำซ้ำ • Ctrl+K ค้นหา • Ctrl+Z ย้อนกลับ • Delete ลบ
          </Panel>
        </ReactFlow>
      </div>

      {/* ศูนย์ส่งออกโค้ด */}
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
}: {
  onOpen: (name: string) => void;
  onOffline: () => void;
  onShowWiki: (name: string) => void;
}) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [error, setError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error();
      let projects = ((await res.json()).projects ?? []) as ProjectSummary[];
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
          <h1 className="text-xl font-bold text-slate-100">MongoModel</h1>
          <span className="text-xs text-slate-500">ออกแบบโครงสร้างข้อมูล MongoDB</span>
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
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-sky-500"
                placeholder="ชื่อโปรเจกต์ใหม่…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void create()}
              />
              <button
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
                onClick={() => void create()}
              >
                ＋ สร้างโปรเจกต์
              </button>
              <button
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
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
              <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500">
                ยังไม่มีโปรเจกต์ — สร้างอันแรกจากช่องด้านบน หรือนำเข้าไฟล์ (เช่น erp-example.json)
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {list.map((p) => (
                  <div
                    key={p.name}
                    className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 hover:border-sky-700"
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
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/wiki/${encodeURIComponent(project)}`);
        if (!res.ok) throw new Error();
        if (alive) setData((await res.json()) as WikiData);
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
            />
          </ReactFlowProvider>
        ) : project === null ? (
          <ProjectHome onOpen={openProject} onOffline={() => setOffline(true)} onShowWiki={toggleWiki} />
        ) : (
          // key=project → สลับโปรเจกต์ = remount สะอาด
          <ReactFlowProvider key={project}>
            <Designer
              project={project}
              offline={false}
              onExit={() => setProject(null)}
              onShowWiki={toggleWiki}
              wikiOpen={wiki === project}
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
