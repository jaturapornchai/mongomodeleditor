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
  type Workflow,
  type WorkflowDataAccess,
  type WorkflowIssue,
  type WorkflowReferenceIndex,
  type WorkflowStep,
  type WorkflowValue,
} from "./workflow";

type WorkflowNode = Node<WorkflowStep, "workflow">;
type WorkflowEdgeData = { label?: string; condition?: string };
type WorkflowEdge = Edge<WorkflowEdgeData>;
type WorkflowMeta = Omit<Workflow, "steps" | "transitions">;
type CollectionOption = {
  id: string;
  label: string;
  fields: { id: string; path: string; type: string }[];
};

const uid = () => crypto.randomUUID().slice(0, 8);
const KIND_STYLE: Record<WorkflowStep["kind"], { icon: string; label: string; border: string; head: string }> = {
  start: { icon: "▶", label: "เริ่มต้น", border: "border-emerald-500/60", head: "bg-emerald-500/15 text-emerald-300" },
  action: { icon: "◆", label: "ขั้นตอน", border: "border-sky-500/60", head: "bg-sky-500/15 text-sky-300" },
  decision: { icon: "◇", label: "เงื่อนไข", border: "border-amber-500/60", head: "bg-amber-500/15 text-amber-300" },
  end: { icon: "■", label: "สิ้นสุด", border: "border-violet-500/60", head: "bg-violet-500/15 text-violet-300" },
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
    <div className={`w-64 overflow-hidden rounded-xl border ${style.border} bg-slate-900/95 shadow-[var(--elev-2)] ${selected ? "ring-2 ring-sky-400/70" : ""}`}>
      {data.kind !== "start" && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-slate-950 !bg-amber-400" />}
      <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold ${style.head}`}>
        <span>{style.icon}</span>
        <span>{style.label}</span>
        {data.actor && <span className="ml-auto max-w-28 truncate rounded-full bg-black/20 px-2 py-0.5 font-normal">{data.actor}</span>}
      </div>
      <div className="px-3 py-2.5">
        <div className="font-medium text-slate-100">{data.title}</div>
        <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{data.description}</div>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          {data.api && <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300">{data.api.method} {data.api.path}</span>}
          {!!data.inputs?.length && <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-300">เข้า {data.inputs.length}</span>}
          {!!data.outputs?.length && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">ออก {data.outputs.length}</span>}
          {!!data.dataAccess?.length && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300">ข้อมูล {data.dataAccess.length}</span>}
        </div>
      </div>
      {data.kind !== "end" && <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-slate-950 !bg-sky-400" />}
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
              <button className="mm-ico text-red-400" title="ลบรายการ" onClick={() => onChange(list.filter((_, i) => i !== index) || undefined)}>✕</button>
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
}: {
  values?: WorkflowDataAccess[];
  collections: CollectionOption[];
  onChange: (values: WorkflowDataAccess[] | undefined) => void;
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
        {list.map((item, index) => {
          const collection = collections.find((option) => option.id === item.collection);
          return (
            <div key={index} className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
              <div className="flex gap-1.5">
                <select className="mm-input min-w-0 flex-1" value={item.collection} onChange={(e) => patch(index, { collection: e.target.value, fields: undefined })}>
                  {collections.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <select className="mm-input w-24" value={item.operation} onChange={(e) => patch(index, { operation: e.target.value as WorkflowDataAccess["operation"] })}>
                  {WORKFLOW_OPERATIONS.map((operation) => <option key={operation}>{operation}</option>)}
                </select>
                <button className="mm-ico text-red-400" title="ลบรายการ" onClick={() => onChange(list.filter((_, i) => i !== index) || undefined)}>✕</button>
              </div>
              {!!collection?.fields.length && (
                <select
                  multiple
                  className="mm-input mt-1.5 h-20 w-full"
                  aria-label="ฟิลด์ที่ใช้"
                  value={item.fields ?? []}
                  onChange={(e) => {
                    const fields = [...e.target.selectedOptions].map((option) => option.value);
                    patch(index, { fields: fields.length ? fields : undefined });
                  }}
                >
                  {collection.fields.map((field) => <option key={field.id} value={field.id}>{field.path} · {field.type}</option>)}
                </select>
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
  issues,
  onStep,
  onEdge,
  onDeleteStep,
  onDeleteEdge,
}: {
  step?: WorkflowStep;
  edge?: WorkflowEdge;
  collections: CollectionOption[];
  issues: WorkflowIssue[];
  onStep: (patch: Partial<WorkflowStep>) => void;
  onEdge: (patch: WorkflowEdgeData) => void;
  onDeleteStep: () => void;
  onDeleteEdge: () => void;
}) {
  if (edge) {
    return (
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/8 bg-slate-950/80 p-4">
        <h2 className="text-sm font-semibold text-slate-100">เส้นทาง</h2>
        <label className="mt-4 block text-xs text-slate-400">Label<input className="mm-input mt-1 w-full" value={edge.data?.label ?? ""} onChange={(e) => onEdge({ ...edge.data, label: e.target.value })} /></label>
        <label className="mt-3 block text-xs text-slate-400">เงื่อนไข<textarea className="mm-input mt-1 min-h-24 w-full" value={edge.data?.condition ?? ""} onChange={(e) => onEdge({ ...edge.data, condition: e.target.value })} /></label>
        <button className="mm-btn mt-5 w-full justify-center border-red-500/30 text-red-400" onClick={onDeleteEdge}>🗑 ลบเส้นทาง</button>
      </aside>
    );
  }
  if (!step) {
    return (
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/8 bg-slate-950/80 p-4">
        <h2 className="text-sm font-semibold text-slate-100">ตรวจ Workflow</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">เลือกการ์ดหรือเส้นเพื่อแก้รายละเอียด ข้อมูลที่กรอกจะถูกส่งให้ vibe coding ผ่าน MCP โดยตรง</p>
        <div className="mt-4 space-y-2">
          {issues.length === 0 ? <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 p-3 text-xs text-emerald-300">✓ ไม่พบปัญหา</div> : issues.map((issue, index) => (
            <div key={`${issue.rule}:${issue.step ?? ""}:${index}`} className={`rounded-lg border p-2 text-xs ${issue.level === "error" ? "border-red-500/20 bg-red-500/8 text-red-300" : "border-amber-500/20 bg-amber-500/8 text-amber-300"}`}>{issue.level === "error" ? "●" : "▲"} {issue.message}</div>
          ))}
        </div>
      </aside>
    );
  }
  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/8 bg-slate-950/80 p-4">
      <div className="flex items-center gap-2"><h2 className="text-sm font-semibold text-slate-100">รายละเอียดขั้นตอน</h2><span className="ml-auto text-[10px] text-slate-500">{step.id}</span></div>
      <div className="mt-4 space-y-3">
        <label className="block text-xs text-slate-400">ชื่อขั้นตอน<input className="mm-input mt-1 w-full" value={step.title} onChange={(e) => onStep({ title: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-slate-400">ประเภท<select className="mm-input mt-1 w-full" value={step.kind} onChange={(e) => onStep({ kind: e.target.value as WorkflowStep["kind"] })}>{WORKFLOW_STEP_KINDS.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label className="block text-xs text-slate-400">ผู้ทำ<input className="mm-input mt-1 w-full" value={step.actor ?? ""} placeholder="ผู้ใช้ / Backend" onChange={(e) => onStep({ actor: e.target.value || undefined })} /></label>
        </div>
        <label className="block text-xs text-slate-400">คำอธิบาย<textarea className="mm-input mt-1 min-h-24 w-full" value={step.description} onChange={(e) => onStep({ description: e.target.value })} /></label>
        {step.kind === "action" && (
          <div className="grid grid-cols-[88px_1fr] gap-2">
            <label className="block text-xs text-slate-400">Method<select className="mm-input mt-1 w-full" value={step.api?.method ?? "POST"} onChange={(e) => onStep({ api: { method: e.target.value as NonNullable<WorkflowStep["api"]>["method"], path: step.api?.path || "/api/" } })}>{WORKFLOW_HTTP_METHODS.map((method) => <option key={method}>{method}</option>)}</select></label>
            <label className="block text-xs text-slate-400">API path<input className="mm-input mt-1 w-full" value={step.api?.path ?? ""} placeholder="เว้นว่างถ้าไม่เรียก API" onChange={(e) => onStep({ api: e.target.value ? { method: step.api?.method ?? "POST", path: e.target.value } : undefined })} /></label>
          </div>
        )}
        <ValueEditor label="ข้อมูลเข้า" values={step.inputs} onChange={(inputs) => onStep({ inputs })} />
        <ValueEditor label="ข้อมูลออก" values={step.outputs} onChange={(outputs) => onStep({ outputs })} />
        <DataAccessEditor values={step.dataAccess} collections={collections} onChange={(dataAccess) => onStep({ dataAccess })} />
        <LinesEditor label="กฎธุรกิจ (หนึ่งบรรทัดต่อกฎ)" value={step.rules} onChange={(rules) => onStep({ rules })} />
        <LinesEditor
          label="Errors: code | เงื่อนไข | ข้อความ"
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
}: {
  project: string;
  theme: "dark" | "light";
  onBack: () => void;
  onExit: () => void;
  onToggleTheme: () => void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [meta, setMeta] = useState<WorkflowMeta | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "saved" | "dirty" | "saving" | "conflict" | "error">("loading");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const revRef = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<Workflow | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const { fitView } = useReactFlow<WorkflowNode>();

  const references = useMemo<WorkflowReferenceIndex>(() =>
    Object.fromEntries(collections.map((collection) => [
      collection.id,
      { label: collection.label, fields: Object.fromEntries(collection.fields.map((field) => [field.id, field.path])) },
    ])), [collections]);

  const current = useMemo(() => meta ? fromFlow(meta, nodes, edges) : null, [meta, nodes, edges]);
  const issues = useMemo(() => current ? lintWorkflow(current, references) : [], [current, references]);

  const openWorkflow = useCallback((workflow: Workflow) => {
    const nextMeta: WorkflowMeta = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      trigger: workflow.trigger,
      ...(workflow.preconditions && { preconditions: structuredClone(workflow.preconditions) }),
      ...(workflow.successOutcome && { successOutcome: workflow.successOutcome }),
      ...(workflow.acceptanceCriteria && { acceptanceCriteria: structuredClone(workflow.acceptanceCriteria) }),
    };
    const flow = toFlow(workflow);
    setSelectedId(workflow.id);
    setMeta(nextMeta);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedStep(null);
    setSelectedEdge(null);
    setConfirmDelete(false);
    setTimeout(() => void fitView({ padding: 0.18, duration: 250 }), 60);
  }, [fitView]);

  const load = useCallback(async (conditional = false) => {
    try {
      const url = `/api/projects/${encodeURIComponent(project)}/workflows${conditional ? `?rev=${revRef.current}` : ""}`;
      const response = await fetch(url);
      if (response.status === 204) return;
      if (!response.ok) throw new Error();
      const body = await response.json() as { rev: number; workflows: Workflow[]; collections: CollectionOption[] };
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
      }
      setStatus("saved");
      setMessage("");
    } catch {
      setStatus("error");
      setMessage("โหลด workflow ไม่สำเร็จ");
    }
  }, [openWorkflow, project, selectedId]);

  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const workflow = pending.current;
    if (!workflow) {
      await saveChain.current;
      return;
    }
    pending.current = null;
    setStatus("saving");
    saveChain.current = saveChain.current.then(async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(project)}/workflows`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow, expectedRev: revRef.current }),
        });
        if (response.status === 409) {
          pending.current = workflow;
          setStatus("conflict");
          setMessage("มีการแก้จาก AI หรือหน้าต่างอื่น — โหลดข้อมูลล่าสุดก่อนแก้ต่อ");
          return;
        }
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error);
        const body = await response.json() as { rev: number; workflow: Workflow };
        revRef.current = body.rev;
        setWorkflows((items) => items.map((item) => item.id === body.workflow.id ? body.workflow : item));
        setStatus(pending.current ? "dirty" : "saved");
        setMessage("");
      } catch (error) {
        pending.current = workflow;
        setStatus("error");
        setMessage(error instanceof Error && error.message ? error.message : "บันทึกไม่สำเร็จ");
      }
    });
    await saveChain.current;
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

  useEffect(() => {
    void load();
    return () => window.clearTimeout(saveTimer.current);
    // โหลดครั้งเดียวต่อ project; poll ด้านล่างดูแลการเปลี่ยนภายนอก
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!pending.current && status !== "saving" && status !== "conflict") void load(true);
    }, 2500);
    return () => window.clearInterval(interval);
  }, [load, status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  const createWorkflow = async (workflow: Workflow) => {
    await flush();
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
      else { setSelectedId(""); setMeta(null); setNodes([]); setEdges([]); }
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

  const selectedStepData = nodes.find((node) => node.id === selectedStep)?.data;
  const selectedEdgeData = edges.find((edge) => edge.id === selectedEdge);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-950">
      <header className="mm-bar z-20 flex items-center gap-2 px-4 py-2.5">
        <button className="mm-btn" onClick={() => void flush().then(onBack)}>← Schema</button>
        <button className="mm-btn border-transparent bg-transparent px-2" title="กลับหน้าโปรเจกต์" onClick={() => void flush().then(onExit)}>⌂</button>
        <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-xs text-violet-300">🔀 Workflow</span>
        <span className="max-w-52 truncate text-sm font-medium text-slate-200">{project}</span>
        <span className={`ml-2 text-[11px] ${status === "conflict" || status === "error" ? "text-red-400" : status === "saving" || status === "dirty" ? "text-amber-300" : "text-emerald-400"}`}>
          {status === "loading" ? "กำลังโหลด…" : status === "saving" ? "กำลังบันทึก…" : status === "dirty" ? "มีการแก้ไข" : status === "conflict" ? "แก้ชนกัน" : status === "error" ? "บันทึกไม่สำเร็จ" : "บันทึกแล้ว"}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button className="mm-btn mm-btn-accent" onClick={() => void createWorkflow(blankWorkflow())}>＋ Workflow</button>
          <button className="mm-btn" onClick={() => void createWorkflow(loginWorkflowTemplate())}>✨ ตัวอย่าง Login</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("action")}>＋ ขั้นตอน</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("decision")}>◇ เงื่อนไข</button>
          <button className="mm-btn" disabled={!current} onClick={() => addStep("end")}>■ จุดจบ</button>
          <button className="mm-btn" disabled={!current} onClick={() => void fitView({ padding: 0.18, duration: 250 })}>⛶ Fit</button>
          <button
            className="mm-btn mm-btn-primary"
            disabled={!current}
            onClick={() => current && void navigator.clipboard.writeText(workflowToMarkdown(current, references)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })}
          >
            {copied ? "✓ คัดลอกแล้ว" : "📋 AI Context"}
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
            className={`mm-tab shrink-0 px-3.5 py-2 text-sm ${workflow.id === selectedId ? "mm-tab-active" : ""}`}
            onClick={() => void flush().then(() => openWorkflow(workflow))}
          >
            {workflow.status === "approved" ? "✓" : "○"} {workflow.name}
          </button>
        ))}
      </div>

      {(message || status === "conflict") && (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
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
            <div className="mt-5 flex justify-center gap-2"><button className="mm-btn mm-btn-primary" onClick={() => void createWorkflow(blankWorkflow())}>＋ Workflow ว่าง</button><button className="mm-btn" onClick={() => void createWorkflow(loginWorkflowTemplate())}>✨ ตัวอย่าง Login</button></div>
          </div>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-white/8 bg-slate-950/80 p-4">
            <div className="flex items-center"><h2 className="text-sm font-semibold text-slate-100">ข้อมูล Workflow</h2></div>
            <div className="mt-4 space-y-3">
              <label className="block text-xs text-slate-400">ชื่อ<input className="mm-input mt-1 w-full" value={meta?.name ?? ""} onChange={(e) => updateMeta({ name: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">สถานะ<select className="mm-input mt-1 w-full" value={meta?.status ?? "draft"} onChange={(e) => updateMeta({ status: e.target.value as Workflow["status"] })}><option value="draft">draft — กำลังออกแบบ</option><option value="approved">approved — ใช้อ้างอิงได้</option></select></label>
              <label className="block text-xs text-slate-400">เป้าหมาย<textarea className="mm-input mt-1 min-h-24 w-full" value={meta?.description ?? ""} onChange={(e) => updateMeta({ description: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">Trigger<textarea className="mm-input mt-1 min-h-20 w-full" value={meta?.trigger ?? ""} onChange={(e) => updateMeta({ trigger: e.target.value })} /></label>
              <label className="block text-xs text-slate-400">ผลลัพธ์เมื่อสำเร็จ<textarea className="mm-input mt-1 min-h-20 w-full" value={meta?.successOutcome ?? ""} onChange={(e) => updateMeta({ successOutcome: e.target.value || undefined })} /></label>
              <LinesEditor label="เงื่อนไขก่อนเริ่ม" value={meta?.preconditions} onChange={(preconditions) => updateMeta({ preconditions })} />
              <LinesEditor label="Acceptance criteria" value={meta?.acceptanceCriteria} onChange={(acceptanceCriteria) => updateMeta({ acceptanceCriteria })} />
              {confirmDelete ? <div className="rounded-lg border border-red-500/30 bg-red-500/8 p-2 text-xs text-red-300"><div>ลบ workflow นี้ทั้งชุด?</div><div className="mt-2 flex gap-2"><button className="mm-btn flex-1 justify-center" onClick={() => setConfirmDelete(false)}>ยกเลิก</button><button className="mm-btn flex-1 justify-center border-red-500/40 text-red-400" onClick={() => void deleteWorkflow()}>ยืนยันลบ</button></div></div> : <button className="mm-btn w-full justify-center border-red-500/20 text-red-400" onClick={() => setConfirmDelete(true)}>🗑 ลบ Workflow</button>}
            </div>
          </aside>

          <main className="relative min-w-0 flex-1" aria-label="ผัง workflow">
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
              onNodeClick={(_, node) => { setSelectedStep(node.id); setSelectedEdge(null); }}
              onEdgeClick={(_, edge) => { setSelectedEdge(edge.id); setSelectedStep(null); }}
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
            issues={issues}
            onStep={updateStep}
            onEdge={updateEdge}
            onDeleteStep={deleteStep}
            onDeleteEdge={deleteEdge}
          />
        </div>
      )}
    </div>
  );
}
