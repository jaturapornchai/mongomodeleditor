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
    fields: n.data.fields.map((f) => ({ ...f, id: uid() })),
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
    updateNodeData(id, {
      fields: data.fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)),
    });

  const removeField = (fid: string) => {
    updateNodeData(id, { fields: data.fields.filter((f) => f.id !== fid) });
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

      {/* รายการฟิลด์ */}
      <div className="divide-y divide-slate-700/60">
        {data.fields.map((f, fi) => {
          const nameErr =
            f.name.trim() === ""
              ? "ชื่อว่าง"
              : data.fields.some((o) => o.id !== f.id && o.name === f.name)
                ? "ชื่อซ้ำ"
                : "";
          return (
            <div
              key={f.id}
              className="group px-3 py-1"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex.current !== null) reorderField(dragIndex.current, fi);
                dragIndex.current = null;
              }}
            >
              <div className="relative flex items-center gap-1.5">
                <Handle type="target" position={Position.Left} id={`${f.id}-t`} />
                {/* จับ ⠿ ลากปล่อยเพื่อจัดลำดับ field */}
                <span
                  className="nodrag shrink-0 cursor-grab select-none text-slate-600 opacity-40 hover:text-slate-300 active:cursor-grabbing"
                  title="ลากเพื่อจัดลำดับฟิลด์"
                  draggable
                  onDragStart={(e) => {
                    dragIndex.current = fi;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(fi));
                  }}
                  onDragEnd={() => {
                    dragIndex.current = null;
                  }}
                >
                  ⠿
                </span>
                {/* _id = primary key ของ MongoDB — first-wins ตรงกับ codegen: ตัวซ้ำทีหลังไม่ใช่ PK ต้องคุม required ได้ */}
                <span className="w-4 shrink-0 text-center text-xs">
                  {f.name === "_id" && data.fields.findIndex((o) => o.name === "_id") === fi ? (
                    <span title="Primary key">🔑</span>
                  ) : (
                    <button
                      className={`nodrag font-bold ${f.required ? "text-red-400" : "text-slate-600 hover:text-slate-400"}`}
                      title={f.required ? "จำเป็นต้องมี (คลิกเพื่อยกเลิก)" : "ไม่บังคับ (คลิกเพื่อบังคับ)"}
                      onClick={() => patchField(f.id, { required: !f.required })}
                    >
                      *
                    </button>
                  )}
                </span>
                <input
                  className={`nodrag w-0 flex-1 rounded px-1 py-0.5 outline-none hover:bg-slate-700/60 focus:bg-slate-700 ${
                    f.name === "_id" ? "font-semibold text-amber-200" : "text-slate-200"
                  } ${nameErr ? "ring-1 ring-red-500" : ""}`}
                  value={f.name}
                  placeholder="ชื่อฟิลด์"
                  title={nameErr || undefined}
                  onChange={(e) => patchField(f.id, { name: e.target.value })}
                />
                <span className="w-5 shrink-0 text-center text-[10px] text-slate-500" title={f.type}>
                  {TYPE_ICON[f.type] ?? "?"}
                </span>
                <select
                  className="nodrag rounded bg-slate-700 px-1 py-0.5 text-[11px] text-slate-300 outline-none"
                  value={f.type}
                  onChange={(e) => {
                    const t = e.target.value as FieldType;
                    // Array แล้วยังไม่มี of → ตั้ง String ให้ตรงกับที่ select โชว์ (native select ไม่ยิง onChange ถ้าเลือกค่าเดิม)
                    // ออกจาก Array → ล้าง of ทิ้ง กัน key ค้างใน export/backup JSON
                    patchField(
                      f.id,
                      t === "Array"
                        ? f.of === undefined
                          ? { type: t, of: "String" }
                          : { type: t }
                        : { type: t, of: undefined }
                    );
                  }}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                {/* actions รอง — โผล่ตอน hover แถว กัน node รก */}
                <button
                  className={`nodrag shrink-0 text-[10px] ${
                    f.enum?.length || f.default != null
                      ? "text-sky-300"
                      : "text-slate-500 hidden group-hover:inline-block hover:text-slate-300"
                  }`}
                  title="ตั้ง enum / ค่าเริ่มต้น"
                  onClick={() => editEnumDefault(f)}
                >
                  ◇
                </button>
                <button
                  className={`nodrag shrink-0 text-[10px] font-bold ${
                    f.unique
                      ? "text-amber-300"
                      : "text-slate-600 hidden group-hover:inline-block hover:text-slate-400"
                  }`}
                  title="unique index"
                  onClick={() => patchField(f.id, { unique: !f.unique })}
                >
                  U
                </button>
                <button
                  className={`nodrag shrink-0 text-[10px] ${f.description ? "opacity-90" : "opacity-25 hover:opacity-70"}`}
                  title={f.description ? "แก้คำอธิบายฟิลด์" : "เพิ่มคำอธิบายฟิลด์"}
                  onClick={() => editFieldDescription(f)}
                >
                  💬
                </button>
                <button
                  className="nodrag text-slate-600 hover:text-red-400"
                  title="ลบฟิลด์"
                  onClick={() => removeField(f.id)}
                >
                  ✕
                </button>
                <Handle type="source" position={Position.Right} id={`${f.id}-s`} />
              </div>
              {/* ชนิดสมาชิก Array — บรรทัด 2 เพื่อไม่บีบชื่อฟิลด์ */}
              {f.type === "Array" && (
                <div className="mt-0.5 flex items-center gap-1.5 pl-[22px] pr-1 text-[10px] text-slate-400/90">
                  <span>ของ</span>
                  <select
                    className="nodrag rounded bg-slate-700 px-1 py-0.5 text-[10px] text-slate-300 outline-none"
                    title="ชนิดสมาชิกของ Array"
                    value={f.of ?? "String"}
                    onChange={(e) => patchField(f.id, { of: e.target.value as FieldType })}
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
              {/* enum / default — แสดง inline ถ้าตั้งไว้ */}
              {((f.enum?.length ?? 0) > 0 || f.default != null) && (
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
            </div>
          );
        })}
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

// ---------- ศูนย์ส่งออกโค้ด ----------

const CODE_TABS = ["mongosh", "Mongoose", "TypeScript", "Markdown", "ตัวอย่าง", "JSON"] as const;
type CodeTab = (typeof CODE_TABS)[number];

// ---------- หน้าหลัก ----------

function Designer() {
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
  const fileInput = useRef<HTMLInputElement>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadedId = useRef(""); // diagram id ที่โหลดเข้า state แล้ว (กัน autosave ก่อนโหลด)
  const { fitView } = useReactFlow();

  // โหลด index + diagram แรกตอน mount
  useEffect(() => {
    const idx = loadIndex();
    setTabs(idx.tabs);
    openDiagram(idx.cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDiagram = (id: string) => {
    const d = loadDiagram(id);
    setNodes(d.nodes);
    setEdges(d.edges);
    setCur(id);
    loadedId.current = id;
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  };

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

  // บันทึก index เมื่อ tabs/cur เปลี่ยน
  useEffect(() => {
    if (tabs.length) trySave(INDEX_KEY, JSON.stringify({ tabs, cur }));
  }, [tabs, cur, trySave]);

  // บันทึกอัตโนมัติ (หน่วง 400ms)
  useEffect(() => {
    if (!cur || loadedId.current !== cur) return;
    const t = setTimeout(() => trySave(dataKey(cur), JSON.stringify({ nodes, edges })), 400);
    return () => clearTimeout(t);
  }, [nodes, edges, cur, trySave]);

  const saveNow = useCallback(() => {
    if (cur) trySave(dataKey(cur), JSON.stringify({ nodes, edges }));
  }, [cur, nodes, edges, trySave]);

  // กันปิดแท็บก่อน autosave 400ms ทำงาน
  useEffect(() => {
    window.addEventListener("beforeunload", saveNow);
    return () => window.removeEventListener("beforeunload", saveNow);
  }, [saveNow]);

  // แท็บเบราว์เซอร์อื่นแก้ diagram เดียวกัน → เตือนกันงานทับ
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
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
    setTabs((ts) => [...ts, { id, name: `Diagram ${ts.length + 1}` }]);
    openDiagram(id);
  };

  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!confirm(`ลบ "${tab?.name}" ทิ้งถาวร?`)) return;
    localStorage.removeItem(dataKey(id));
    const rest = tabs.filter((t) => t.id !== id);
    if (!rest.length) {
      // เหลือ 0 → สร้างอันใหม่ว่างๆ
      const nid = uid();
      trySave(dataKey(nid), JSON.stringify({ nodes: [], edges: [] }));
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

  // sync label เส้น = ชื่อฟิลด์ต้นทาง (+ cardinality ถ้ามี) — คำนวณใหม่ทุกครั้งให้ตาม rename ทัน
  useEffect(() => {
    setEdges((es) => {
      let changed = false;
      const next = es.map((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const fid = e.sourceHandle?.replace(/-s$/, "");
        const name = src?.data.fields.find((f) => f.id === fid)?.name ?? "";
        const card = e.data?.cardinality ? CARD_LABEL[e.data.cardinality] : "";
        const label =
          name && card ? `${name} · ${card}` : name || card || undefined;
        if (e.label === label) return e; // เท่าเดิม → คงอ้างอิงเดิม กัน render loop
        changed = true;
        return { ...e, label };
      });
      return changed ? next : es;
    });
  }, [nodes, edges, setEdges]);

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

  // hover node → เส้นที่เกี่ยวข้องสว่าง เส้นอื่นจาง (derive อย่างเดียว ไม่แตะ state จริง)
  const displayEdges = useMemo(() => {
    if (!hoveredId) return edges;
    return edges.map((e) => {
      const base = e.style ?? { stroke: "#64748b", strokeWidth: 1.5 };
      return e.source === hoveredId || e.target === hoveredId
        ? { ...e, style: { ...base, stroke: "#38bdf8", opacity: 1 } }
        : { ...e, style: { ...base, opacity: 0.2 } };
    });
  }, [edges, hoveredId]);

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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, setNodes]);

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

  // นำเข้า = สร้างแท็บใหม่เสมอ (ไม่ทับงานปัจจุบัน) — รองรับทั้งไฟล์เดี่ยวและไฟล์สำรองทั้งชุด
  // parse ไฟล์เป็นรายการ diagram — รับทั้งแบบเดี่ยว {nodes,edges} และแบบสำรองทั้งชุด {diagrams:[]}
  const parseDiagramFile = (raw: string, fallback: string) => {
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
  };

  const readFile = (file: File, use: (list: ReturnType<typeof parseDiagramFile>) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        use(parseDiagramFile(String(reader.result), file.name.replace(/\.json$/i, "")));
      } catch {
        alert("ไฟล์ไม่ถูกต้อง — ต้องเป็น JSON ที่ส่งออกจาก MongoModel");
      }
    };
    reader.readAsText(file);
  };

  // นำเข้า = เพิ่มเป็นแท็บใหม่ (ไม่ทับงานเดิม)
  const importJson = (file: File) =>
    readFile(file, (list) => {
      saveNow();
      let lastId = "";
      for (const d of list) {
        const id = uid();
        trySave(dataKey(id), JSON.stringify({ nodes: d.nodes, edges: d.edges }));
        setTabs((ts) => [...ts, { id, name: d.name }]);
        lastId = id;
      }
      openDiagram(lastId);
    });

  // เปิดโปรเจกต์ = ล้างทุกแท็บในเครื่องแล้วโหลดจากไฟล์มาแทนทั้งหมด
  const openProject = (file: File) =>
    readFile(file, (list) => {
      if (!confirm(`เปิดโปรเจกต์นี้จะแทนที่งานทั้งหมดในเครื่อง (${tabs.length} diagram) — ทำต่อ?`))
        return;
      for (const t of tabs) localStorage.removeItem(dataKey(t.id));
      const newTabs = list.map((d) => {
        const id = uid();
        trySave(dataKey(id), JSON.stringify({ nodes: d.nodes, edges: d.edges }));
        return { id, name: d.name };
      });
      setTabs(newTabs);
      openDiagram(newTabs[0].id);
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
            : codeTab === "ตัวอย่าง"
              ? gn.map((n) => `// ${n.data.label}\n` + toSampleDoc(n)).join("\n\n")
              : JSON.stringify({ nodes, edges }, null, 2);
  }, [codeOpen, codeTab, nodes, edges]);

  return (
    <div className="flex h-screen flex-col bg-slate-950">
      {/* แถบเครื่องมือ */}
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2">
        <span className="h-3 w-3 rounded-full bg-emerald-500" />
        <h1 className="font-bold text-slate-100">MongoModel</h1>
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
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            onClick={() => openInput.current?.click()}
          >
            📂 เปิดโปรเจกต์
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
        <input
          ref={openInput}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openProject(f);
            e.target.value = "";
          }}
        />
      </header>

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
            diagram อาจถูกแก้จากแท็บเบราว์เซอร์อื่น — refresh ก่อนแก้ต่อเพื่อกันงานทับกัน
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
            ทำซ้ำ • Ctrl+K ค้นหา • Delete ลบ
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

export default function Page() {
  return (
    <ReactFlowProvider>
      <Designer />
    </ReactFlowProvider>
  );
}
