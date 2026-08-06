"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  WORKFLOW_HTTP_METHODS,
  WORKFLOW_OPERATIONS,
  WORKFLOW_STEP_KINDS,
  blankWorkflow,
  lintWorkflow,
  loginWorkflowTemplate,
  workflowToMarkdown,
  workflowSchemaUsage,
  type Workflow,
  type WorkflowDataAccess,
  type WorkflowIssue,
  type WorkflowReferenceIndex,
  type WorkflowSchemaUsage,
  type WorkflowStep,
  type WorkflowValue,
} from "./workflow";
import { layoutWorkflow } from "./workflow-layout";

type WorkflowNode = Node<WorkflowStep, "workflow">;
type WorkflowEdgeData = { label?: string; condition?: string };
type WorkflowEdge = Edge<WorkflowEdgeData>;
type WorkflowMeta = Omit<Workflow, "steps" | "transitions">;
type SaveStatus = "loading" | "saved" | "dirty" | "saving" | "conflict" | "error";
type CollectionOption = {
  id: string;
  label: string;
  diagram: string;
  diagramName: string;
  fields: { id: string; path: string; type: string }[];
};

export type SchemaFocusTarget = { diagram: string; collection: string; field?: string };

const uid = () => crypto.randomUUID().slice(0, 8);
const HISTORY_CAP = 50;
const serializeWorkflow = (workflow: Workflow) => JSON.stringify(workflow);
const workflowMeta = (workflow: Workflow): WorkflowMeta => ({
  id: workflow.id,
  name: workflow.name,
  description: workflow.description,
  status: workflow.status,
  trigger: workflow.trigger,
  ...(workflow.preconditions && { preconditions: structuredClone(workflow.preconditions) }),
  ...(workflow.successOutcome && { successOutcome: workflow.successOutcome }),
  ...(workflow.acceptanceCriteria && { acceptanceCriteria: structuredClone(workflow.acceptanceCriteria) }),
});
const KIND_STYLE: Record<WorkflowStep["kind"], { icon: string; label: string; border: string; head: string }> = {
  start: { icon: "▶", label: "เริ่มต้น", border: "border-emerald-500/60", head: "bg-emerald-500/15 text-emerald-300" },
  action: { icon: "◆", label: "ขั้นตอน", border: "border-sky-500/60", head: "bg-sky-500/15 text-sky-300" },
  decision: { icon: "◇", label: "เงื่อนไข", border: "border-amber-500/60", head: "bg-amber-500/15 text-amber-300" },
  end: { icon: "■", label: "สิ้นสุด", border: "border-violet-500/60", head: "bg-violet-500/15 text-violet-300" },
};
const OPERATION_LABEL: Record<WorkflowDataAccess["operation"], string> = {
  read: "อ่าน (Read)",
  create: "สร้าง (Create)",
  update: "แก้ไข (Update)",
  delete: "ลบ (Delete)",
};
const SAVE_STATUS: Record<SaveStatus, { label: string; icon: string; style: string }> = {
  loading: { label: "กำลังโหลด", icon: "◌", style: "border-slate-500/25 bg-slate-500/10 text-slate-400" },
  saved: { label: "บันทึกแล้ว", icon: "✓", style: "border-emerald-500/25 bg-emerald-500/10 text-emerald-400" },
  dirty: { label: "รอบันทึก", icon: "●", style: "border-amber-500/25 bg-amber-500/10 text-amber-300" },
  saving: { label: "กำลังบันทึก", icon: "↻", style: "border-sky-500/25 bg-sky-500/10 text-sky-300" },
  conflict: { label: "ข้อมูลชนกัน", icon: "!", style: "border-red-500/30 bg-red-500/10 text-red-400" },
  error: { label: "บันทึกไม่สำเร็จ", icon: "!", style: "border-red-500/30 bg-red-500/10 text-red-400" },
};

const toFlow = (workflow: Workflow): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } => ({
  nodes: workflow.steps.map((step) => ({
    id: step.id,
    type: "workflow",
    position: step.position,
    data: structuredClone(step),
  })),
  edges: workflow.transitions.map((transition) => ({
    id: transition.id,
    source: transition.source,
    target: transition.target,
    type: "smoothstep",
    label: transition.label || transition.condition,
    data: { label: transition.label, condition: transition.condition },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#38bdf8" },
    style: { stroke: "#38bdf8", strokeWidth: 1.5 },
  })),
});

const fromFlow = (meta: WorkflowMeta, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({
  ...meta,
  steps: nodes.map((node) => ({
    ...node.data,
    id: node.id,
    position: { x: node.position.x, y: node.position.y },
  })),
  transitions: edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.data?.label?.trim() && { label: edge.data.label.trim() }),
    ...(edge.data?.condition?.trim() && { condition: edge.data.condition.trim() }),
  })),
});

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowNode>) {
  const style = KIND_STYLE[data.kind];
  return (
    <div className={`mm-card w-64 overflow-hidden border ${style.border} ${selected ? "mm-card-selected" : ""}`}>
      {data.kind !== "start" && <Handle type="target" position={Position.Top} className="!h-3 !w-3 !border-2 !border-slate-950 !bg-amber-400" />}
      <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold ${style.head}`}>
        <span>{style.icon}</span>
        <span>{style.label}</span>
        {data.actor && <span className="ml-auto max-w-28 truncate rounded-full bg-black/20 px-2 py-0.5 font-normal">{data.actor}</span>}
      </div>
      <div className="px-3 py-2.5">
        <div className="font-medium text-slate-100">{data.title}</div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{data.description}</div>
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {data.api && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300">{data.api.method} {data.api.path}</span>}
          {!!data.inputs?.length && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-300">เข้า {data.inputs.length}</span>}
          {!!data.outputs?.length && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">ออก {data.outputs.length}</span>}
          {!!data.dataAccess?.length && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300">ข้อมูล {data.dataAccess.length}</span>}
        </div>
      </div>
      {data.kind !== "end" && <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !border-2 !border-slate-950 !bg-sky-400" />}
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNodeView };

function LinesEditor({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value?: string[];
  placeholder?: string;
  onChange: (value: string[] | undefined) => void;
}) {
  return (
    <label className="block text-xs text-slate-400">
      <span>{label}</span>
      <textarea
        className="mm-input mt-1 min-h-20 w-full resize-y"
        value={(value ?? []).join("\n")}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
          onChange(next.length ? next : undefined);
        }}
      />
    </label>
  );
}

function ValueEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values?: WorkflowValue[];
  onChange: (values: WorkflowValue[] | undefined) => void;
}) {
  const list = values ?? [];
  const patch = (index: number, value: Partial<WorkflowValue>) =>
    onChange(list.map((item, i) => (i === index ? { ...item, ...value } : item)));
  return (
    <section>
      <div className="mb-1 flex items-center text-xs font-medium text-slate-300">
        {label}
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-sky-300 hover:bg-sky-500/10"
          onClick={() => onChange([...list, { name: "value", type: "String", description: "อธิบายข้อมูล" }])}
        >
          ＋ เพิ่ม
        </button>
      </div>
      <div className="space-y-2">
        {list.map((item, index) => (
          <div key={index} className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
            <div className="flex gap-1.5">
              <input className="mm-input min-w-0 flex-1" aria-label={`${label} ชื่อ`} value={item.name} onChange={(e) => patch(index, { name: e.target.value })} />
              <input className="mm-input w-24" aria-label={`${label} ชนิด`} value={item.type} onChange={(e) => patch(index, { type: e.target.value })} />
              <button className="mm-ico text-red-400" title="ลบรายการ" onClick={() => { const next = list.filter((_, i) => i !== index); onChange(next.length ? next : undefined); }}>✕</button>
            </div>
            <input className="mm-input mt-1.5 w-full" aria-label={`${label} คำอธิบาย`} value={item.description} onChange={(e) => patch(index, { description: e.target.value })} />
            <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
              <input type="checkbox" checked={Boolean(item.required)} onChange={(e) => patch(index, { required: e.target.checked || undefined })} /> บังคับ
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function DataAccessEditor({
  values,
  collections,
  onChange,
  onOpenSchema,
}: {
  values?: WorkflowDataAccess[];
  collections: CollectionOption[];
  onChange: (values: WorkflowDataAccess[] | undefined) => void;
  onOpenSchema: (target: SchemaFocusTarget) => void;
}) {
  const list = values ?? [];
  const patch = (index: number, value: Partial<WorkflowDataAccess>) =>
    onChange(list.map((item, i) => (i === index ? { ...item, ...value } : item)));
  return (
    <section>
      <div className="mb-1 flex items-center text-xs font-medium text-slate-300">
        อ่าน/เขียนข้อมูล
        <button
          className="ml-auto rounded px-1.5 py-0.5 text-sky-300 hover:bg-sky-500/10"
          disabled={!collections.length}
          onClick={() => collections[0] && onChange([...list, { collection: collections[0].id, operation: "read" }])}
        >
          ＋ เพิ่ม
        </button>
      </div>
      <div className="space-y-2">
        {!collections.length && <div className="rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 text-xs leading-relaxed text-amber-300">ยังไม่มี Collection — กลับไปหน้า Schema เพื่อสร้างข้อมูลก่อน</div>}
        {list.map((item, index) => {
          const collection = collections.find((option) => option.id === item.collection);
          return (
            <div key={index} className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
              <div className="flex gap-1.5">
                <select aria-label="คอลเลกชันใน Schema" className="mm-input min-w-0 flex-1" value={item.collection} onChange={(e) => patch(index, { collection: e.target.value, fields: undefined })}>
                  {!collection && <option value={item.collection}>⚠ ไม่พบ Collection เดิม</option>}
                  {collections.map((option) => <option key={option.id} value={option.id}>{option.diagramName} · {option.label}</option>)}
                </select>
                <select aria-label="การทำงานกับข้อมูล" className="mm-input w-32" value={item.operation} onChange={(e) => patch(index, { operation: e.target.value as WorkflowDataAccess["operation"] })}>
                  {WORKFLOW_OPERATIONS.map((operation) => <option key={operation} value={operation}>{OPERATION_LABEL[operation]}</option>)}
                </select>
                <button className="mm-ico text-red-400" title="ลบรายการ" onClick={() => { const next = list.filter((_, i) => i !== index); onChange(next.length ? next : undefined); }}>✕</button>
              </div>
              {!collection && <div className="mt-1.5 text-[11px] text-amber-300">Collection นี้อาจถูกลบหรือเปลี่ยน Schema แล้ว กรุณาเลือกใหม่</div>}
              {!!collection?.fields.length && (
                <fieldset className="mt-2 rounded-lg border border-white/8 p-2">
                  <legend className="px-1 text-[11px] font-medium text-slate-400">ฟิลด์ที่ใช้ <span className="font-normal text-slate-500">· เลือกได้หลายรายการ</span></legend>
                  <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
                    {collection.fields.map((field) => {
                      const checked = item.fields?.includes(field.id) ?? false;
                      return (
                        <label key={field.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-slate-300 hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              const fields = checked ? (item.fields ?? []).filter((id) => id !== field.id) : [...(item.fields ?? []), field.id];
                              patch(index, { fields: fields.length ? fields : undefined });
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate">{field.path}</span>
                          <span className="text-[10px] text-slate-500">{field.type}</span>
                        </label>
                      );
                    })}
                  </div>
                  {!item.fields?.length && <div className="mt-1 text-[10px] text-slate-500">ไม่เลือก = ใช้ Collection โดยรวม</div>}
                </fieldset>
              )}
              {collection && (
                <button
                  className="mm-btn mt-1.5 w-full justify-center border-violet-500/25 text-violet-300"
                  title={`เปิด ${collection.label} ในแท็บ ${collection.diagramName}`}
                  onClick={() => onOpenSchema({
                    diagram: collection.diagram,
                    collection: collection.id,
                    ...(item.fields?.[0] && { field: item.fields[0] }),
                  })}
                >
                  ↗ เปิด {collection.label} ใน Schema
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WorkflowInspector({
  step,
  edge,
  collections,
  schemaUsage,
  issues,
  onStep,
  onEdge,
  onDeleteStep,
  onDeleteEdge,
  onOpenSchema,
  onClose,
  overviewOpen,
  onOpenOverview,
}: {
  step?: WorkflowStep;
  edge?: WorkflowEdge;
  collections: CollectionOption[];
  schemaUsage: WorkflowSchemaUsage[];
  issues: WorkflowIssue[];
  onStep: (patch: Partial<WorkflowStep>) => void;
  onEdge: (patch: WorkflowEdgeData) => void;
  onDeleteStep: () => void;
  onDeleteEdge: () => void;
  onOpenSchema: (target: SchemaFocusTarget) => void;
  onClose: () => void;
  overviewOpen: boolean;
  onOpenOverview: () => void;
}) {
  if (edge) {
    return (
      <aside className="order-3 max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-white/8 bg-slate-950/80 p-4 xl:max-h-none xl:w-80 xl:border-l xl:border-t-0">
        <div className="flex items-center"><h2 className="text-sm font-semibold text-slate-100">เส้นทาง</h2><button className="mm-ico ml-auto" title="ปิดรายละเอียด" onClick={onClose}>✕</button></div>
        <label className="mt-4 block text-xs text-slate-400">ชื่อเส้นทาง<input className="mm-input mt-1 w-full" value={edge.data?.label ?? ""} onChange={(e) => onEdge({ ...edge.data, label: e.target.value })} /></label>
        <label className="mt-3 block text-xs text-slate-400">เงื่อนไข<textarea className="mm-input mt-1 min-h-24 w-full" value={edge.data?.condition ?? ""} onChange={(e) => onEdge({ ...edge.data, condition: e.target.value })} /></label>
        <button className="mm-btn mt-5 w-full justify-center border-red-500/30 text-red-400" onClick={onDeleteEdge}>🗑 ลบเส้นทาง</button>
      </aside>
    );
  }
  if (!step) {
    if (!overviewOpen) {
      return <button className={`mm-btn order-3 m-3 self-start xl:absolute xl:right-4 xl:top-4 xl:z-10 xl:m-0 ${issues.length ? "border-amber-500/30 text-amber-300" : "text-emerald-400"}`} onClick={onOpenOverview}>🩺 {issues.length ? `${issues.length} จุด` : "Workflow พร้อม"}</button>;
    }
    return (
      <aside className="order-3 max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-white/8 bg-slate-950/90 p-4 xl:absolute xl:right-4 xl:top-4 xl:z-10 xl:max-h-[calc(100%-2rem)] xl:w-72 xl:rounded-xl xl:border">
        <div className="flex items-center"><h2 className="text-sm font-semibold text-slate-100">ตรวจ Workflow</h2><button className="mm-ico ml-auto" title="ย่อคำแนะนำ" onClick={onClose}>✕</button></div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">ผังนี้บันทึกอัตโนมัติ และส่งให้ vibe coding อ่านผ่าน MCP ได้ทันที</p>
        <ol className="mt-4 space-y-2 text-xs text-slate-300">
          <li className="flex gap-2"><span className="text-sky-400">1</span><span>คลิกการ์ดเพื่อกรอกรายละเอียดของแต่ละขั้นตอน</span></li>
          <li className="flex gap-2"><span className="text-sky-400">2</span><span>ลากจุดสีฟ้าไปจุดสีเหลืองเพื่อเชื่อมลำดับงาน</span></li>
          <li className="flex gap-2"><span className="text-sky-400">3</span><span>ผูก Collection และฟิลด์ เพื่อให้ AI เข้าใจข้อมูลที่ใช้</span></li>
        </ol>
        <section className="mt-4 border-t border-white/10 pt-3" aria-label="Schema ที่เกี่ยวข้อง">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-violet-300">▣ Schema ที่เกี่ยวข้อง</h3>
            <span className="ml-auto rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-300">{schemaUsage.length}</span>
          </div>
          <div className="mt-2 space-y-2">
            {!schemaUsage.length && <div className="rounded-lg border border-amber-500/20 bg-amber-500/8 p-2 text-xs leading-relaxed text-amber-300">ยังไม่ได้ผูก Schema — เลือกขั้นตอนแล้วเพิ่มใน “อ่าน/เขียนข้อมูล”</div>}
            {schemaUsage.map((usage) => {
              const collection = collections.find((option) => option.id === usage.collection);
              const fieldNames = usage.fields.map((id) => collection?.fields.find((field) => field.id === id)?.path ?? id);
              return (
                <button
                  key={usage.collection}
                  className="block w-full rounded-lg border border-white/8 bg-white/[0.03] p-2 text-left hover:border-violet-400/35 hover:bg-violet-500/8"
                  title={collection ? `เปิด ${collection.label} ในแท็บ ${collection.diagramName}` : "ไม่พบ Collection ที่อ้างถึง"}
                  onClick={() => collection && onOpenSchema({ diagram: collection.diagram, collection: collection.id, ...(usage.fields[0] && { field: usage.fields[0] }) })}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`truncate font-medium ${collection ? "text-slate-100" : "text-amber-300"}`}>{collection?.label ?? `⚠ ${usage.collection}`}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-500">{usage.steps.length} ขั้นตอน ↗</span>
                  </div>
                  {collection && <div className="mt-0.5 truncate text-[10px] text-slate-500">{collection.diagramName}</div>}
                  <div className="mt-1.5 flex flex-wrap gap-1">{usage.operations.map((operation) => <span key={operation} className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">{OPERATION_LABEL[operation]}</span>)}</div>
                  <div className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-slate-400">{fieldNames.length ? fieldNames.join(", ") : "ใช้ทั้ง Collection"}</div>
                </button>
              );
            })}
          </div>
        </section>
        <div className="mt-4 space-y-2">
          {issues.length === 0 ? <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 p-3 text-xs text-emerald-300">✓ ไม่พบปัญหา</div> : issues.map((issue, index) => (
            <div key={`${issue.rule}:${issue.step ?? ""}:${index}`} className={`rounded-lg border p-2 text-xs ${issue.level === "error" ? "border-red-500/20 bg-red-500/8 text-red-300" : "border-amber-500/20 bg-amber-500/8 text-amber-300"}`}>{issue.level === "error" ? "●" : "▲"} {issue.message}</div>
          ))}
        </div>
      </aside>
    );
  }
  return (
    <aside className="order-3 max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-white/8 bg-slate-950/80 p-4 xl:max-h-none xl:w-80 xl:border-l xl:border-t-0">
      <div className="flex items-center gap-2"><h2 className="text-sm font-semibold text-slate-100">รายละเอียดขั้นตอน</h2><span className="ml-auto text-[10px] text-slate-500">{step.id}</span><button className="mm-ico" title="ปิดรายละเอียด" onClick={onClose}>✕</button></div>
      <div className="mt-4 space-y-3">
        <label className="block text-xs text-slate-400">ชื่อขั้นตอน<input className="mm-input mt-1 w-full" value={step.title} onChange={(e) => onStep({ title: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-400">ประเภท<select className="mm-input mt-1 w-full" value={step.kind} onChange={(e) => onStep({ kind: e.target.value as WorkflowStep["kind"] })}>{WORKFLOW_STEP_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_STYLE[kind].label}</option>)}</select></label>
          <label className="block text-xs text-slate-400">ผู้รับผิดชอบ<input className="mm-input mt-1 w-full" value={step.actor ?? ""} placeholder="ผู้ใช้ / Backend" onChange={(e) => onStep({ actor: e.target.value || undefined })} /></label>
        </div>
        <label className="block text-xs text-slate-400">คำอธิบาย<textarea className="mm-input mt-1 min-h-24 w-full" value={step.description} onChange={(e) => onStep({ description: e.target.value })} /></label>
        {step.kind === "action" && (
          <div className="grid grid-cols-[88px_1fr] gap-2">
            <label className="block text-xs text-slate-400">HTTP Method<select className="mm-input mt-1 w-full" value={step.api?.method ?? "POST"} onChange={(e) => onStep({ api: { method: e.target.value as NonNullable<WorkflowStep["api"]>["method"], path: step.api?.path || "/api/" } })}>{WORKFLOW_HTTP_METHODS.map((method) => <option key={method}>{method}</option>)}</select></label>
            <label className="block text-xs text-slate-400">API path<input className="mm-input mt-1 w-full" value={step.api?.path ?? ""} placeholder="เว้นว่างถ้าไม่เรียก API" onChange={(e) => onStep({ api: e.target.value ? { method: step.api?.method ?? "POST", path: e.target.value } : undefined })} /></label>
          </div>
        )}
        <ValueEditor label="ข้อมูลเข้า" values={step.inputs} onChange={(inputs) => onStep({ inputs })} />
        <ValueEditor label="ข้อมูลออก" values={step.outputs} onChange={(outputs) => onStep({ outputs })} />
        <DataAccessEditor values={step.dataAccess} collections={collections} onChange={(dataAccess) => onStep({ dataAccess })} onOpenSchema={onOpenSchema} />
        <LinesEditor label="กฎธุรกิจ (หนึ่งบรรทัดต่อกฎ)" value={step.rules} onChange={(rules) => onStep({ rules })} />
        <LinesEditor
          label="ข้อผิดพลาด: code | เงื่อนไข | ข้อความ"
          value={step.errors?.map((item) => `${item.code} | ${item.condition} | ${item.message}`)}
          placeholder="401 | รหัสผ่านไม่ถูกต้อง | ข้อมูลเข้าสู่ระบบไม่ถูกต้อง"
          onChange={(lines) => onStep({ errors: lines?.map((line) => { const [code = "ERROR", condition = "เกิดข้อผิดพลาด", message = "ดำเนินการไม่สำเร็จ"] = line.split("|").map((part) => part.trim()); return { code, condition, message }; }) })}
        />
        <button className="mm-btn w-full justify-center border-red-500/30 text-red-400" onClick={onDeleteStep}>🗑 ลบขั้นตอน</button>
      </div>
    </aside>
  );
}

export default function WorkflowEditor({
  project,
  theme,
  onBack,
  onExit,
  onToggleTheme,
  onOpenSchema,
}: {
  project: string;
  theme: "dark" | "light";
  onBack: () => void;
  onExit: () => void;
  onToggleTheme: () => void;
  onOpenSchema: (target: SchemaFocusTarget) => void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [meta, setMeta] = useState<WorkflowMeta | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(true);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [arranging, setArranging] = useState(false);
  const revRef = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<Workflow | null>(null);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const present = useRef("");
  const skipHistory = useRef(false);
  const [historySizes, setHistorySizes] = useState({ past: 0, future: 0 });
  const { fitView } = useReactFlow<WorkflowNode>();

  const syncHistorySizes = useCallback(() =>
    setHistorySizes({ past: past.current.length, future: future.current.length }), []);

  const references = useMemo<WorkflowReferenceIndex>(() =>
    Object.fromEntries(collections.map((collection) => [
      collection.id,
      { label: collection.label, fields: Object.fromEntries(collection.fields.map((field) => [field.id, field.path])) },
    ])), [collections]);

  const current = useMemo(() => meta ? fromFlow(meta, nodes, edges) : null, [meta, nodes, edges]);
  const issues = useMemo(() => current ? lintWorkflow(current, references) : [], [current, references]);
  const schemaUsage = useMemo(() => current ? workflowSchemaUsage(current) : [], [current]);

  const applyWorkflowState = useCallback((workflow: Workflow) => {
    const flow = toFlow(workflow);
    setSelectedId(workflow.id);
    setMeta(workflowMeta(workflow));
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedStep(null);
    setSelectedEdge(null);
    setConfirmDelete(false);
  }, []);

  const resetHistory = useCallback((workflow?: Workflow) => {
    past.current = [];
    future.current = [];
    present.current = workflow ? serializeWorkflow(workflow) : "";
    skipHistory.current = false;
    syncHistorySizes();
  }, [syncHistorySizes]);

  const openWorkflow = useCallback((workflow: Workflow) => {
    applyWorkflowState(workflow);
    resetHistory(workflow);
    setTimeout(() => void fitView({ padding: 0.18, duration: 250 }), 60);
  }, [applyWorkflowState, fitView, resetHistory]);

  const load = useCallback(async (conditional = false) => {
    try {
      const url = `/api/projects/${encodeURIComponent(project)}/workflows${conditional ? `?rev=${revRef.current}` : ""}`;
      const response = await fetch(url);
      if (response.status === 204) return;
      if (!response.ok) throw new Error();
      const body = await response.json() as { rev: number; workflows: Workflow[]; collections: CollectionOption[] };
      if (conditional && pending.current) return;
      revRef.current = body.rev;
      setCollections(body.collections ?? []);
      setWorkflows(body.workflows ?? []);
      const next = body.workflows.find((workflow) => workflow.id === selectedId) ?? body.workflows[0];
      if (next) openWorkflow(next);
      else {
        setSelectedId("");
        setMeta(null);
        setNodes([]);
        setEdges([]);
        resetHistory();
      }
      setStatus("saved");
      setMessage("");
    } catch {
      setStatus("error");
      setMessage("โหลด workflow ไม่สำเร็จ");
    }
  }, [openWorkflow, project, resetHistory, selectedId]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    while (true) {
      const queued = saveChain.current;
      await queued;
      if (queued !== saveChain.current) continue;
      const workflow = pending.current;
      if (!workflow) return true;
      pending.current = null;
      setStatus("saving");
      saveChain.current = (async () => {
        try {
          const response = await fetch(`/api/projects/${encodeURIComponent(project)}/workflows`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workflow, expectedRev: revRef.current }),
          });
          if (response.status === 409) {
            pending.current ??= workflow;
            setStatus("conflict");
            setMessage("มีการแก้จาก AI หรือหน้าต่างอื่น — โหลดข้อมูลล่าสุดก่อนแก้ต่อ");
            return false;
          }
          if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error);
          const body = await response.json() as { rev: number; workflow: Workflow };
          revRef.current = body.rev;
          setWorkflows((items) => items.map((item) => item.id === body.workflow.id ? body.workflow : item));
          setStatus(pending.current ? "dirty" : "saved");
          setMessage("");
          return true;
        } catch (error) {
          pending.current ??= workflow;
          setStatus("error");
          setMessage(error instanceof Error && error.message ? error.message : "บันทึกไม่สำเร็จ");
          return false;
        }
      })();
      if (!await saveChain.current) return false;
    }
  }, [project]);

  const schedule = useCallback((workflow: Workflow) => {
    pending.current = workflow;
    setWorkflows((items) => items.map((item) => item.id === workflow.id ? workflow : item));
    setStatus("dirty");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 650);
  }, [flush]);

  const commit = useCallback((nextMeta: WorkflowMeta, nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]) =>
    schedule(fromFlow(nextMeta, nextNodes, nextEdges)), [schedule]);

  const commitHistory = useCallback(() => {
    if (!current) return;
    const snapshot = serializeWorkflow(current);
    if (snapshot === present.current) return;
    past.current.push(present.current);
    if (past.current.length > HISTORY_CAP) past.current.shift();
    present.current = snapshot;
    future.current = [];
    syncHistorySizes();
  }, [current, syncHistorySizes]);

  useEffect(() => {
    if (!current) return;
    if (skipHistory.current) {
      skipHistory.current = false;
      return;
    }
    const timer = window.setTimeout(commitHistory, 400);
    return () => window.clearTimeout(timer);
  }, [commitHistory, current]);

  // historySizes ทำให้ render ใหม่เมื่อ present เปลี่ยน จึงอ่าน ref ตรงนี้ได้โดยไม่สร้าง state ซ้ำ
  // eslint-disable-next-line react-hooks/refs
  const historyDirty = current ? serializeWorkflow(current) !== present.current : false;

  const restoreHistory = useCallback((snapshot: string) => {
    const workflow = JSON.parse(snapshot) as Workflow;
    const keepStep = selectedStep && workflow.steps.some((step) => step.id === selectedStep) ? selectedStep : null;
    const keepEdge = selectedEdge && workflow.transitions.some((edge) => edge.id === selectedEdge) ? selectedEdge : null;
    skipHistory.current = true;
    applyWorkflowState(workflow);
    setSelectedStep(keepStep);
    setSelectedEdge(keepEdge);
    schedule(workflow);
  }, [applyWorkflowState, schedule, selectedEdge, selectedStep]);

  const undo = useCallback(() => {
    commitHistory();
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(present.current);
    present.current = previous;
    restoreHistory(previous);
    syncHistorySizes();
  }, [commitHistory, restoreHistory, syncHistorySizes]);

  const redo = useCallback(() => {
    commitHistory();
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(present.current);
    present.current = next;
    restoreHistory(next);
    syncHistorySizes();
  }, [commitHistory, restoreHistory, syncHistorySizes]);

  useEffect(() => {
    void load();
    return () => {
      window.clearTimeout(saveTimer.current);
      void flush();
    };
    // โหลดครั้งเดียวต่อ project; poll ด้านล่างดูแลการเปลี่ยนภายนอก
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!pending.current) return;
      void flush();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [flush]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!pending.current && status !== "saving" && status !== "conflict") void load(true);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [load, status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void flush();
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, redo, undo]);

  const createWorkflow = async (workflow: Workflow) => {
    if (!await flush()) return;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, expectedRev: revRef.current }),
      });
      if (response.status === 409) { setStatus("conflict"); setMessage("ชื่อซ้ำหรือ project ถูกแก้จากที่อื่น — โหลดใหม่แล้วลองอีกครั้ง"); return; }
      if (!response.ok) throw new Error();
      const body = await response.json() as { rev: number; workflow: Workflow };
      revRef.current = body.rev;
      setWorkflows((items) => [...items, body.workflow]);
      openWorkflow(body.workflow);
      setStatus("saved");
    } catch { setStatus("error"); setMessage("สร้าง workflow ไม่สำเร็จ"); }
  };

  const deleteWorkflow = async () => {
    if (!current) return;
    window.clearTimeout(saveTimer.current);
    const saved = await saveChain.current;
    if (!saved && pending.current) return;
    pending.current = null;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project)}/workflows`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: current.id, expectedRev: revRef.current }),
      });
      if (response.status === 409) { setStatus("conflict"); setMessage("project ถูกแก้จากที่อื่น — โหลดใหม่ก่อนลบ"); return; }
      if (!response.ok) throw new Error();
      const body = await response.json() as { rev: number };
      revRef.current = body.rev;
      const rest = workflows.filter((workflow) => workflow.id !== current.id);
      setWorkflows(rest);
      if (rest[0]) openWorkflow(rest[0]);
      else { setSelectedId(""); setMeta(null); setNodes([]); setEdges([]); resetHistory(); }
      setConfirmDelete(false);
      setStatus("saved");
    } catch { setStatus("error"); setMessage("ลบ workflow ไม่สำเร็จ"); }
  };

  const updateMeta = (patch: Partial<WorkflowMeta>) => {
    if (!meta) return;
    const next = { ...meta, ...patch };
    setMeta(next);
    commit(next, nodes, edges);
  };
  const updateStep = (patch: Partial<WorkflowStep>) => {
    const next = nodes.map((node) => node.id === selectedStep ? { ...node, data: { ...node.data, ...patch } } : node);
    setNodes(next);
    if (meta) commit(meta, next, edges);
  };
  const updateEdge = (patch: WorkflowEdgeData) => {
    const next = edges.map((edge) => edge.id === selectedEdge ? { ...edge, label: patch.label || patch.condition, data: patch } : edge);
    setEdges(next);
    if (meta) commit(meta, nodes, next);
  };
  const deleteStep = () => {
    if (!selectedStep || !meta) return;
    const nextNodes = nodes.filter((node) => node.id !== selectedStep);
    const nextEdges = edges.filter((edge) => edge.source !== selectedStep && edge.target !== selectedStep);
    setNodes(nextNodes); setEdges(nextEdges); setSelectedStep(null);
    commit(meta, nextNodes, nextEdges);
  };
  const deleteEdge = () => {
    if (!selectedEdge || !meta) return;
    const next = edges.filter((edge) => edge.id !== selectedEdge);
    setEdges(next); setSelectedEdge(null); commit(meta, nodes, next);
  };
  const addStep = (kind: WorkflowStep["kind"]) => {
    if (!meta) return;
    const id = `step_${uid()}`;
    const step: WorkflowStep = {
      id,
      kind,
      title: KIND_STYLE[kind].label,
      description: `อธิบาย${KIND_STYLE[kind].label}นี้`,
      position: { x: 180 + nodes.length * 40, y: 120 + nodes.length * 35 },
    };
    const next = [...nodes, { id, type: "workflow" as const, position: step.position, data: step }];
    setNodes(next); setSelectedStep(id); setSelectedEdge(null); commit(meta, next, edges);
  };
  const onConnect = (connection: Connection) => {
    if (!meta || !connection.source || !connection.target) return;
    const id = `transition_${uid()}`;
    const edge: WorkflowEdge = {
      id, source: connection.source, target: connection.target, type: "smoothstep",
      data: {}, markerEnd: { type: MarkerType.ArrowClosed, color: "#38bdf8" },
      style: { stroke: "#38bdf8", strokeWidth: 1.5 },
    };
    const next = [...edges, edge]; setEdges(next); setSelectedEdge(id); setSelectedStep(null); commit(meta, nodes, next);
  };
  const onNodesChange = (changes: NodeChange<WorkflowNode>[]) => setNodes((items) => applyNodeChanges(changes, items));
  const onEdgesChange = (changes: EdgeChange<WorkflowEdge>[]) => {
    const next = applyEdgeChanges(changes, edges);
    setEdges(next);
    if (meta && changes.some((change) => change.type === "remove")) commit(meta, nodes, next);
  };
  const autoLayout = async () => {
    if (!meta || arranging || nodes.length === 0) return;
    setArranging(true);
    try {
      const positions = await layoutWorkflow(
        nodes.map((node) => ({
          id: node.id,
          width: node.measured?.width ?? 256,
          height: node.measured?.height ?? 120,
        })),
        edges,
      );
      const next = nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
      setNodes(next);
      commit(meta, next, edges);
      setMessage("");
      setTimeout(() => void fitView({ padding: 0.18, duration: 400 }), 60);
    } catch {
      setMessage("จัดผัง workflow ไม่สำเร็จ");
    } finally {
      setArranging(false);
    }
  };

  const open3d = () => {
    if (!current) return;
    const query = new URLSearchParams({ project, workflow: current.id });
    if (selectedStep) query.set("step", selectedStep);
    const target = new URL(`/workflow-3d?${query}`, window.location.origin).toString();
    const preview = window.open("about:blank", "_blank");
    if (!preview) {
      setMessage("เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต pop-up แล้วลองอีกครั้ง");
      return;
    }
    preview.opener = null;
    preview.document.title = "กำลังเปิด Workflow 3D";
    preview.document.body.textContent = "กำลังบันทึกและเปิด Workflow 3D…";
    preview.document.body.style.cssText = "margin:0;display:grid;place-items:center;height:100vh;background:#020617;color:#67e8f9;font:14px system-ui";
    void flush().then((saved) => {
      if (saved) preview.location.replace(target);
      else preview.close();
    });
  };

  const selectedStepData = nodes.find((node) => node.id === selectedStep)?.data;
  const selectedEdgeData = edges.find((edge) => edge.id === selectedEdge);
  const uniqueWorkflowName = (base: string) => {
    const names = new Set(workflows.map((workflow) => workflow.name));
    if (!names.has(base)) return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`)) suffix += 1;
    return `${base} ${suffix}`;
  };
  const saveStatus = SAVE_STATUS[status];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950">
      <header className="mm-bar z-20 flex items-center gap-2 px-3 py-2.5">
        <button className="mm-btn" onClick={() => void flush().then((saved) => saved && onBack())}>← Schema</button>
        <button className="mm-btn border-transparent bg-transparent px-2" title="กลับหน้าโปรเจกต์" onClick={() => void flush().then((saved) => saved && onExit())}>⌂</button>
        <span className="shrink-0 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-xs text-violet-300">🔀 <span className="hidden sm:inline">Workflow</span></span>
        <span className="hidden max-w-40 truncate text-sm font-medium text-slate-200 lg:inline">{project}</span>
        <span role="status" aria-live="polite" className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${saveStatus.style}`}>
          {saveStatus.icon} {saveStatus.label}
        </span>
        <div className="mm-toolbar ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <button className="mm-btn" onClick={() => void createWorkflow(blankWorkflow(uniqueWorkflowName("Workflow ใหม่")))}>＋ งานใหม่</button>
          <button className="mm-btn" onClick={() => void createWorkflow(loginWorkflowTemplate(uniqueWorkflowName("เข้าสู่ระบบ")))}>✨ ตัวอย่าง Login</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("action")}>＋ ขั้นตอน</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("decision")}>◇ เงื่อนไข</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("end")}>■ จบ</button>
          <button className="mm-btn px-2.5" title="ย้อนการแก้ผัง (Ctrl+Z เมื่อไม่ได้พิมพ์ข้อความ)" disabled={!current || (historySizes.past === 0 && !historyDirty)} onClick={undo}>↶</button>
          <button className="mm-btn px-2.5" title="ทำซ้ำ (Ctrl+Y / Ctrl+Shift+Z)" disabled={!current || historySizes.future === 0} onClick={redo}>↷</button>
          <button className="mm-btn" title="จัดเรียงขั้นตอนอัตโนมัติ ไม่ให้ทับกัน" disabled={!current || arranging || nodes.length === 0} onClick={() => void autoLayout()}>{arranging ? "◌ กำลังจัด..." : "▦ จัดผัง"}</button>
          <button className={`mm-btn ${issues.length ? "border-amber-500/30 text-amber-300" : "text-emerald-400"}`} disabled={!current} onClick={() => { setSelectedStep(null); setSelectedEdge(null); setShowOverview(true); }}>🩺 {issues.length ? `${issues.length} จุด` : "ผ่าน"}</button>
          <button className="mm-btn" disabled={!current} onClick={() => void fitView({ padding: 0.18, duration: 250 })}>⛶ พอดี</button>
          <button className="mm-btn border-cyan-400/30 bg-cyan-400/10 text-cyan-200" title="เปิดโหมดเดินสำรวจ Workflow ในแท็บใหม่" disabled={!current || nodes.length === 0} onClick={open3d}>🎮 เดิน 3D</button>
          <button
            className="mm-btn mm-btn-primary"
            disabled={!current}
            onClick={() => current && void navigator.clipboard.writeText(workflowToMarkdown(current, references)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}
          >
            {copied ? "✓ คัดลอกแล้ว" : "📋 ส่งให้ AI"}
          </button>
          <button className="mm-btn px-2.5" title={theme === "dark" ? "ใช้โหมดสว่าง" : "ใช้โหมดมืด"} onClick={onToggleTheme}>{theme === "dark" ? "☀️" : "🌙"}</button>
        </div>
      </header>

      <div className="mm-bar flex min-h-11 items-end gap-1 overflow-x-auto px-3 pt-2" role="tablist" aria-label="รายการ workflow">
        {workflows.map((workflow) => (
          <button
            key={workflow.id}
            role="tab"
            aria-selected={workflow.id === selectedId}
            className={`mm-tab max-w-56 shrink-0 truncate px-3.5 py-2 text-sm ${workflow.id === selectedId ? "mm-tab-active" : ""}`}
            onClick={() => void flush().then((saved) => saved && openWorkflow(workflow))}
          >
            {workflow.status === "approved" ? "✓" : "○"} {workflow.name}
          </button>
        ))}
      </div>

      {(message || status === "conflict") && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          <span className="flex-1">⚠ {message}</span>
          <button className="mm-btn" onClick={() => { pending.current = null; void load(); }}>โหลดข้อมูลล่าสุด</button>
        </div>
      )}

      {!current ? (
        <main className="flex flex-1 items-center justify-center">
          <div className="mm-panel max-w-lg p-8 text-center">
            <div className="text-4xl">🔀</div>
            <h2 className="mt-3 text-lg font-semibold text-slate-100">สร้าง Workflow แรก</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">สร้างผังว่าง หรือเริ่มจากตัวอย่าง Login ที่มี success/error path และ acceptance criteria พร้อมให้ vibe coding อ่าน</p>
            <div className="mt-5 flex flex-wrap justify-center gap-2"><button className="mm-btn mm-btn-primary" onClick={() => void createWorkflow(blankWorkflow(uniqueWorkflowName("Workflow ใหม่")))}>＋ Workflow ว่าง</button><button className="mm-btn" onClick={() => void createWorkflow(loginWorkflowTemplate(uniqueWorkflowName("เข้าสู่ระบบ")))}>✨ ตัวอย่าง Login</button></div>
          </div>
        </main>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
          <aside className="order-2 max-h-[42vh] w-full shrink-0 overflow-y-auto border-t border-white/8 bg-slate-950/80 p-4 xl:order-1 xl:max-h-none xl:w-60 xl:border-r xl:border-t-0 2xl:w-72">
            <div className="flex items-center"><h2 className="text-sm font-semibold text-slate-100">ภาพรวม Workflow</h2></div>
            <div className="mt-4 space-y-3">
              <label className="block text-xs text-slate-400">ชื่อ<input className="mm-input mt-1 w-full" value={meta?.name ?? ""} onChange={(e) => updateMeta({ name: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">สถานะ<select className="mm-input mt-1 w-full" value={meta?.status ?? "draft"} onChange={(e) => updateMeta({ status: e.target.value as Workflow["status"] })}><option value="draft">กำลังออกแบบ (draft)</option><option value="approved">อนุมัติแล้ว (approved)</option></select></label>
              <label className="block text-xs text-slate-400">เป้าหมาย<textarea className="mm-input mt-1 min-h-24 w-full" value={meta?.description ?? ""} onChange={(e) => updateMeta({ description: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">เหตุการณ์เริ่มงาน<textarea className="mm-input mt-1 min-h-20 w-full" value={meta?.trigger ?? ""} onChange={(e) => updateMeta({ trigger: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">ผลลัพธ์เมื่อสำเร็จ<textarea className="mm-input mt-1 min-h-20 w-full" value={meta?.successOutcome ?? ""} onChange={(e) => updateMeta({ successOutcome: e.target.value || undefined })} /></label>
              <LinesEditor label="เงื่อนไขก่อนเริ่ม" value={meta?.preconditions} onChange={(preconditions) => updateMeta({ preconditions })} />
              <LinesEditor label="เงื่อนไขที่ถือว่าสำเร็จ" value={meta?.acceptanceCriteria} onChange={(acceptanceCriteria) => updateMeta({ acceptanceCriteria })} />
              {confirmDelete ? <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-2 text-xs text-red-300"><div>ลบ workflow นี้ทั้งชุด?</div><div className="mt-2 flex gap-2"><button className="mm-btn flex-1 justify-center" onClick={() => setConfirmDelete(false)}>ยกเลิก</button><button className="mm-btn flex-1 justify-center border-red-500/40 text-red-400" onClick={() => void deleteWorkflow()}>ยืนยันลบ</button></div></div> : <button className="mm-btn w-full justify-center border-red-500/20 text-red-400" onClick={() => setConfirmDelete(true)}>🗑 ลบ Workflow</button>}
            </div>
          </aside>

          <main id="mm-workflow-canvas" className="relative order-1 min-h-[480px] w-full flex-none xl:order-2 xl:min-h-0 xl:flex-1" aria-label="ผัง workflow">
            <ReactFlow
              colorMode={theme}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={(_, node) => {
                if (!meta) return;
                const next = nodes.map((item) => item.id === node.id ? { ...item, position: node.position } : item);
                setNodes(next); commit(meta, next, edges);
              }}
              onNodeClick={(_, node) => { setSelectedStep(node.id); setSelectedEdge(null); setShowOverview(false); }}
              onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setSelectedStep(null); setShowOverview(false); }}
              onPaneClick={() => { setSelectedStep(null); setSelectedEdge(null); }}
              onConnect={onConnect}
              fitView
              minZoom={0.2}
              maxZoom={1.8}
              deleteKeyCode={null}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={theme === "dark" ? "#1e293b" : "#cbd5e1"} />
              <Controls position="bottom-left" />
              <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => node.data.kind === "decision" ? "#f59e0b" : node.data.kind === "start" ? "#10b981" : node.data.kind === "end" ? "#8b5cf6" : "#0ea5e9"} />
            </ReactFlow>
          </main>

          <WorkflowInspector
            step={selectedStepData}
            edge={selectedEdgeData}
            collections={collections}
            schemaUsage={schemaUsage}
            issues={issues}
            onStep={updateStep}
            onEdge={updateEdge}
            onDeleteStep={deleteStep}
            onDeleteEdge={deleteEdge}
            onOpenSchema={(target) => void flush().then((saved) => saved && onOpenSchema(target))}
            onClose={() => { setSelectedStep(null); setSelectedEdge(null); setShowOverview(false); }}
            overviewOpen={showOverview}
            onOpenOverview={() => setShowOverview(true)}
          />
        </div>
      )}
    </div>
  );
}
