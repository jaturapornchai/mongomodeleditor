export const WORKFLOW_STEP_KINDS = ["start", "action", "decision", "end"] as const;
export const WORKFLOW_STATUSES = ["draft", "approved"] as const;
export const WORKFLOW_OPERATIONS = ["read", "create", "update", "delete"] as const;
export const WORKFLOW_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];
export type WorkflowHttpMethod = (typeof WORKFLOW_HTTP_METHODS)[number];

export type WorkflowValue = {
  name: string;
  type: string;
  required?: boolean;
  description: string;
};

export type WorkflowDataAccess = {
  collection: string; // collection node id — rename แล้ว reference ไม่หลุด
  fields?: string[]; // field ids ของ collection เดียวกัน
  operation: WorkflowOperation;
};

export type WorkflowStep = {
  id: string;
  kind: WorkflowStepKind;
  title: string;
  description: string;
  actor?: string;
  position: { x: number; y: number };
  inputs?: WorkflowValue[];
  outputs?: WorkflowValue[];
  api?: { method: WorkflowHttpMethod; path: string };
  dataAccess?: WorkflowDataAccess[];
  rules?: string[];
  errors?: { code: string; condition: string; message: string }[];
};

export type WorkflowTransition = {
  id: string;
  source: string;
  target: string;
  label?: string;
  condition?: string;
};

export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  trigger: string;
  preconditions?: string[];
  successOutcome?: string;
  acceptanceCriteria?: string[];
  steps: WorkflowStep[];
  transitions: WorkflowTransition[];
};

export type WorkflowIssue = {
  level: "error" | "warn";
  rule: string;
  message: string;
  step?: string;
};

export type WorkflowReferenceIndex = Record<
  string,
  { label: string; fields: Record<string, string> }
>;

const THAI_RE = /[\u0E00-\u0E7F]/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 2_000): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;
const isOptionalText = (value: unknown, max = 2_000): value is string | undefined =>
  value === undefined || (typeof value === "string" && value.length <= max);
const isTextArray = (value: unknown, maxItems = 100): value is string[] =>
  Array.isArray(value) && value.length <= maxItems && value.every((item) => isText(item));

/** ตรวจ payload จาก REST/import ก่อนบันทึก — คืน machine code เดียวกับ MCP */
export function workflowInputError(value: unknown): string | null {
  if (!isRecord(value)) return "[WORKFLOW_INVALID] workflow ต้องเป็น object";
  if (!isText(value.id, 100) || !ID_RE.test(value.id) || RESERVED_IDS.has(value.id))
    return "[WORKFLOW_ID_INVALID] id ใช้ได้เฉพาะ A-Z, a-z, 0-9, _ และ - (ไม่เกิน 100 ตัว)";
  if (!isText(value.name, 200)) return "[WORKFLOW_NAME_INVALID] ต้องระบุชื่อ workflow ไม่เกิน 200 ตัว";
  if (!isText(value.description)) return "[WORKFLOW_DESCRIPTION_REQUIRED] ต้องระบุคำอธิบาย workflow";
  if (!WORKFLOW_STATUSES.includes(value.status as WorkflowStatus))
    return "[WORKFLOW_STATUS_INVALID] status ต้องเป็น draft หรือ approved";
  if (!isText(value.trigger)) return "[WORKFLOW_TRIGGER_REQUIRED] ต้องระบุ trigger ของ workflow";
  if (value.preconditions !== undefined && !isTextArray(value.preconditions))
    return "[WORKFLOW_PRECONDITIONS_INVALID] preconditions ต้องเป็นรายการข้อความ";
  if (!isOptionalText(value.successOutcome))
    return "[WORKFLOW_OUTCOME_INVALID] successOutcome ต้องเป็นข้อความ";
  if (value.acceptanceCriteria !== undefined && !isTextArray(value.acceptanceCriteria))
    return "[WORKFLOW_ACCEPTANCE_INVALID] acceptanceCriteria ต้องเป็นรายการข้อความ";
  if (!Array.isArray(value.steps) || value.steps.length > 300)
    return "[WORKFLOW_STEPS_INVALID] steps ต้องเป็น array และไม่เกิน 300 ขั้นตอน";
  if (!Array.isArray(value.transitions) || value.transitions.length > 500)
    return "[WORKFLOW_TRANSITIONS_INVALID] transitions ต้องเป็น array และไม่เกิน 500 เส้น";

  const stepIds = new Set<string>();
  for (const raw of value.steps) {
    if (!isRecord(raw)) return "[WORKFLOW_STEP_INVALID] step ต้องเป็น object";
    if (!isText(raw.id, 100) || !ID_RE.test(raw.id) || RESERVED_IDS.has(raw.id))
      return "[WORKFLOW_STEP_ID_INVALID] step id ไม่ถูกต้อง";
    if (stepIds.has(raw.id)) return `[WORKFLOW_STEP_DUPLICATE] step id \"${raw.id}\" ซ้ำ`;
    stepIds.add(raw.id);
    if (!WORKFLOW_STEP_KINDS.includes(raw.kind as WorkflowStepKind))
      return `[WORKFLOW_STEP_KIND_INVALID] kind ของ step \"${raw.id}\" ไม่ถูกต้อง`;
    if (!isText(raw.title, 200) || !isText(raw.description))
      return `[WORKFLOW_STEP_TEXT_REQUIRED] step \"${raw.id}\" ต้องมี title และ description`;
    if (!isOptionalText(raw.actor, 200)) return `[WORKFLOW_ACTOR_INVALID] actor ของ step \"${raw.id}\" ไม่ถูกต้อง`;
    if (
      !isRecord(raw.position) ||
      typeof raw.position.x !== "number" ||
      !Number.isFinite(raw.position.x) ||
      typeof raw.position.y !== "number" ||
      !Number.isFinite(raw.position.y)
    )
      return `[WORKFLOW_POSITION_INVALID] position ของ step \"${raw.id}\" ไม่ถูกต้อง`;

    for (const key of ["inputs", "outputs"] as const) {
      const list = raw[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.length > 100)
        return `[WORKFLOW_VALUE_INVALID] ${key} ของ step \"${raw.id}\" ต้องเป็น array`;
      for (const item of list) {
        if (
          !isRecord(item) ||
          !isText(item.name, 200) ||
          !isText(item.type, 100) ||
          !isText(item.description) ||
          (item.required !== undefined && typeof item.required !== "boolean")
        )
          return `[WORKFLOW_VALUE_INVALID] ${key} ของ step \"${raw.id}\" มีข้อมูลไม่ครบ`;
      }
    }
    if (raw.api !== undefined) {
      if (
        !isRecord(raw.api) ||
        !WORKFLOW_HTTP_METHODS.includes(raw.api.method as WorkflowHttpMethod) ||
        !isText(raw.api.path, 500)
      )
        return `[WORKFLOW_API_INVALID] api ของ step \"${raw.id}\" ไม่ถูกต้อง`;
    }
    if (raw.dataAccess !== undefined) {
      if (!Array.isArray(raw.dataAccess) || raw.dataAccess.length > 100)
        return `[WORKFLOW_DATA_ACCESS_INVALID] dataAccess ของ step \"${raw.id}\" ต้องเป็น array`;
      for (const item of raw.dataAccess) {
        if (
          !isRecord(item) ||
          !isText(item.collection, 100) ||
          !WORKFLOW_OPERATIONS.includes(item.operation as WorkflowOperation) ||
          (item.fields !== undefined && !isTextArray(item.fields, 300))
        )
          return `[WORKFLOW_DATA_ACCESS_INVALID] dataAccess ของ step \"${raw.id}\" ไม่ถูกต้อง`;
      }
    }
    if (raw.rules !== undefined && !isTextArray(raw.rules))
      return `[WORKFLOW_RULES_INVALID] rules ของ step \"${raw.id}\" ต้องเป็นรายการข้อความ`;
    if (raw.errors !== undefined) {
      if (!Array.isArray(raw.errors) || raw.errors.length > 100)
        return `[WORKFLOW_ERRORS_INVALID] errors ของ step \"${raw.id}\" ต้องเป็น array`;
      for (const item of raw.errors) {
        if (
          !isRecord(item) ||
          !isText(item.code, 100) ||
          !isText(item.condition) ||
          !isText(item.message)
        )
          return `[WORKFLOW_ERRORS_INVALID] errors ของ step \"${raw.id}\" มีข้อมูลไม่ครบ`;
      }
    }
  }

  const transitionIds = new Set<string>();
  for (const raw of value.transitions) {
    if (!isRecord(raw)) return "[WORKFLOW_TRANSITION_INVALID] transition ต้องเป็น object";
    if (!isText(raw.id, 100) || !ID_RE.test(raw.id) || RESERVED_IDS.has(raw.id))
      return "[WORKFLOW_TRANSITION_ID_INVALID] transition id ไม่ถูกต้อง";
    if (transitionIds.has(raw.id))
      return `[WORKFLOW_TRANSITION_DUPLICATE] transition id \"${raw.id}\" ซ้ำ`;
    transitionIds.add(raw.id);
    if (!isText(raw.source, 100) || !isText(raw.target, 100))
      return `[WORKFLOW_TRANSITION_INVALID] transition \"${raw.id}\" ต้องมี source และ target`;
    if (!stepIds.has(raw.source) || !stepIds.has(raw.target))
      return `[WORKFLOW_TRANSITION_DANGLING] transition \"${raw.id}\" ชี้ step ที่ไม่มีอยู่`;
    if (!isOptionalText(raw.label, 500) || !isOptionalText(raw.condition))
      return `[WORKFLOW_TRANSITION_INVALID] label/condition ของ transition \"${raw.id}\" ไม่ถูกต้อง`;
  }
  return null;
}

export function lintWorkflow(
  workflow: Workflow,
  references: WorkflowReferenceIndex = {},
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const starts = workflow.steps.filter((step) => step.kind === "start");
  const ends = workflow.steps.filter((step) => step.kind === "end");
  if (starts.length !== 1)
    issues.push({
      level: "error",
      rule: "workflow-start-count",
      message: `ต้องมีจุดเริ่มต้น 1 จุด (ตอนนี้ ${starts.length})`,
    });
  if (ends.length === 0)
    issues.push({ level: "error", rule: "workflow-end-missing", message: "ต้องมีจุดจบอย่างน้อย 1 จุด" });
  if (!THAI_RE.test(workflow.description))
    issues.push({ level: "warn", rule: "workflow-description-thai", message: "คำอธิบาย workflow ควรเป็นภาษาไทย" });
  if (!(workflow.acceptanceCriteria?.length))
    issues.push({
      level: "warn",
      rule: "workflow-acceptance-missing",
      message: "ควรมี acceptance criteria เพื่อให้ AI สร้าง test ได้ตรงกัน",
    });

  const outgoing = new Map<string, WorkflowTransition[]>();
  const incoming = new Map<string, WorkflowTransition[]>();
  for (const edge of workflow.transitions) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  for (const step of workflow.steps) {
    if (!THAI_RE.test(step.description))
      issues.push({
        level: "warn",
        rule: "workflow-step-description-thai",
        step: step.id,
        message: `ขั้นตอน \"${step.title}\" ควรมีคำอธิบายภาษาไทย`,
      });
    if (step.kind === "decision") {
      const branches = outgoing.get(step.id) ?? [];
      if (branches.length < 2)
        issues.push({
          level: "error",
          rule: "workflow-decision-branches",
          step: step.id,
          message: `Decision \"${step.title}\" ต้องมีอย่างน้อย 2 ทางออก`,
        });
      for (const branch of branches)
        if (!branch.label?.trim() && !branch.condition?.trim())
          issues.push({
            level: "warn",
            rule: "workflow-branch-condition",
            step: step.id,
            message: `ทางออกจาก \"${step.title}\" ต้องมี label หรือ condition`,
          });
    }
    if (step.kind !== "end" && !(outgoing.get(step.id)?.length))
      issues.push({
        level: "error",
        rule: "workflow-dead-end",
        step: step.id,
        message: `ขั้นตอน \"${step.title}\" ไม่มีทางไปต่อ`,
      });
    if (step.kind === "start" && (incoming.get(step.id)?.length ?? 0) > 0)
      issues.push({ level: "warn", rule: "workflow-start-incoming", step: step.id, message: "จุดเริ่มต้นไม่ควรมีเส้นเข้ามา" });
    if (step.kind === "end" && (outgoing.get(step.id)?.length ?? 0) > 0)
      issues.push({ level: "warn", rule: "workflow-end-outgoing", step: step.id, message: "จุดจบไม่ควรมีเส้นออก" });
    for (const access of step.dataAccess ?? []) {
      const collection = references[access.collection];
      if (!collection) {
        issues.push({
          level: "error",
          rule: "workflow-collection-missing",
          step: step.id,
          message: `ขั้นตอน \"${step.title}\" อ้าง collection ที่ไม่มีอยู่ (${access.collection})`,
        });
        continue;
      }
      for (const field of access.fields ?? [])
        if (!collection.fields[field])
          issues.push({
            level: "error",
            rule: "workflow-field-missing",
            step: step.id,
            message: `ขั้นตอน \"${step.title}\" อ้าง field ที่ไม่มีอยู่ (${field})`,
          });
    }
  }

  if (starts.length === 1) {
    const reached = new Set<string>();
    const queue = [starts[0].id];
    while (queue.length) {
      const id = queue.shift()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const edge of outgoing.get(id) ?? []) queue.push(edge.target);
    }
    for (const step of workflow.steps)
      if (!reached.has(step.id))
        issues.push({
          level: "error",
          rule: "workflow-unreachable",
          step: step.id,
          message: `ขั้นตอน \"${step.title}\" ไปไม่ถึงจากจุดเริ่มต้น`,
        });
  }
  return issues;
}

const cleanMermaid = (value: string) => value.replace(/["\r\n]/g, " ").trim();
export function workflowToMermaid(workflow: Workflow): string {
  const ids = new Map(workflow.steps.map((step, index) => [step.id, `S${index}`]));
  const lines = ["flowchart TD"];
  for (const step of workflow.steps) {
    const id = ids.get(step.id)!;
    const label = cleanMermaid(step.title);
    if (step.kind === "decision") lines.push(`  ${id}{\"${label}\"}`);
    else if (step.kind === "start" || step.kind === "end") lines.push(`  ${id}([\"${label}\"])`);
    else lines.push(`  ${id}[\"${label}\"]`);
  }
  for (const edge of workflow.transitions) {
    const source = ids.get(edge.source);
    const target = ids.get(edge.target);
    if (!source || !target) continue;
    const label = cleanMermaid(edge.label || edge.condition || "");
    lines.push(label ? `  ${source} -->|\"${label}\"| ${target}` : `  ${source} --> ${target}`);
  }
  return lines.join("\n");
}

const list = (values: string[] | undefined) =>
  values?.length ? values.map((value) => `- ${value}`).join("\n") : "- ไม่มี";

export function workflowToMarkdown(
  workflow: Workflow,
  references: WorkflowReferenceIndex = {},
): string {
  const stepById = new Map(workflow.steps.map((step) => [step.id, step]));
  const out = [
    `# Workflow: ${workflow.name}`,
    "",
    workflow.description,
    "",
    `- สถานะ: ${workflow.status}`,
    `- Trigger: ${workflow.trigger}`,
    `- ผลลัพธ์สำเร็จ: ${workflow.successOutcome || "ยังไม่ระบุ"}`,
    "",
    "## Preconditions",
    "",
    list(workflow.preconditions),
    "",
    "## Steps",
    "",
  ];
  for (const [index, step] of workflow.steps.entries()) {
    out.push(`### ${index + 1}. ${step.title}`, "", step.description, "");
    out.push(`- id: \`${step.id}\``, `- kind: ${step.kind}`, `- actor: ${step.actor || "ไม่ระบุ"}`);
    if (step.api) out.push(`- API: \`${step.api.method} ${step.api.path}\``);
    for (const access of step.dataAccess ?? []) {
      const ref = references[access.collection];
      const fields = (access.fields ?? []).map((id) => ref?.fields[id] ?? id).join(", ");
      out.push(`- Data: ${access.operation} \`${ref?.label ?? access.collection}\`${fields ? ` (${fields})` : ""}`);
    }
    if (step.inputs?.length)
      out.push(`- Input: ${step.inputs.map((value) => `${value.name}: ${value.type}${value.required ? " (required)" : ""}`).join(", ")}`);
    if (step.outputs?.length)
      out.push(`- Output: ${step.outputs.map((value) => `${value.name}: ${value.type}`).join(", ")}`);
    for (const rule of step.rules ?? []) out.push(`- Rule: ${rule}`);
    for (const error of step.errors ?? []) out.push(`- Error ${error.code}: ${error.condition} → ${error.message}`);
    out.push("");
  }
  out.push("## Transitions", "");
  for (const edge of workflow.transitions)
    out.push(`- ${stepById.get(edge.source)?.title ?? edge.source} → ${stepById.get(edge.target)?.title ?? edge.target}${edge.label || edge.condition ? ` (${edge.label || edge.condition})` : ""}`);
  out.push("", "## Acceptance Criteria", "", list(workflow.acceptanceCriteria), "", "## Mermaid", "", "```mermaid", workflowToMermaid(workflow), "```");
  return out.join("\n");
}

const uid = () => crypto.randomUUID().slice(0, 8);

export function blankWorkflow(name = "Workflow ใหม่"): Workflow {
  const id = uid();
  return {
    id,
    name,
    description: "อธิบายเป้าหมายและขอบเขตของขั้นตอนการทำงานนี้",
    status: "draft",
    trigger: "ระบุเหตุการณ์ที่เริ่ม workflow",
    steps: [
      { id: "start", kind: "start", title: "เริ่มต้น", description: "จุดเริ่มต้นของ workflow", position: { x: 80, y: 140 } },
      { id: "end", kind: "end", title: "สำเร็จ", description: "workflow ทำงานเสร็จสมบูรณ์", position: { x: 480, y: 140 } },
    ],
    transitions: [{ id: "start_to_end", source: "start", target: "end", label: "ดำเนินการ" }],
  };
}

export function loginWorkflowTemplate(name = "เข้าสู่ระบบ"): Workflow {
  return {
    id: uid(),
    name,
    description: "ยืนยันตัวตนผู้ใช้และสร้าง session ที่ปลอดภัยก่อนเข้าสู่ระบบ",
    status: "draft",
    trigger: "ผู้ใช้เปิดหน้าเข้าสู่ระบบและกดปุ่มเข้าสู่ระบบ",
    preconditions: ["ระบบยืนยันตัวตนและฐานข้อมูลพร้อมใช้งาน"],
    successOutcome: "ผู้ใช้ได้รับ session และไปยังหน้า Dashboard",
    acceptanceCriteria: [
      "ข้อมูลถูกต้องต้องสร้าง session และไปหน้า Dashboard",
      "ข้อมูลไม่ถูกต้องต้องไม่สร้าง session และตอบข้อความกลางที่ไม่เปิดเผยว่าผิดช่องใด",
      "คำขอเกินอัตราที่กำหนดต้องถูกปฏิเสธโดยไม่ตรวจรหัสผ่านต่อ",
      "ห้ามบันทึกรหัสผ่านแบบ plain text ลง log หรือฐานข้อมูล",
    ],
    steps: [
      { id: "start", kind: "start", title: "เปิดหน้า Login", description: "ผู้ใช้เปิดหน้า /login", actor: "ผู้ใช้", position: { x: 40, y: 180 } },
      {
        id: "input",
        kind: "action",
        title: "กรอกข้อมูลเข้าสู่ระบบ",
        description: "ผู้ใช้กรอกอีเมลและรหัสผ่าน",
        actor: "ผู้ใช้",
        position: { x: 300, y: 180 },
        inputs: [
          { name: "email", type: "String", required: true, description: "อีเมลของผู้ใช้" },
          { name: "password", type: "String", required: true, description: "รหัสผ่านที่ผู้ใช้กรอก" },
        ],
        rules: ["ห้ามเก็บหรือ log รหัสผ่านแบบ plain text"],
      },
      { id: "validate", kind: "decision", title: "ข้อมูลถูกต้อง?", description: "ตรวจช่องบังคับและรูปแบบอีเมล", actor: "Frontend", position: { x: 600, y: 180 } },
      {
        id: "request",
        kind: "action",
        title: "ส่งคำขอ Login",
        description: "ส่งข้อมูลไปยัง API ยืนยันตัวตนผ่าน HTTPS",
        actor: "Frontend",
        position: { x: 900, y: 80 },
        api: { method: "POST", path: "/api/auth/login" },
        rules: ["ตรวจ rate limit ก่อนค้นหาบัญชี", "ใช้ข้อความตอบกลับกลางเพื่อป้องกัน account enumeration"],
        errors: [
          { code: "400", condition: "ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง", message: "ข้อมูลไม่ถูกต้อง" },
          { code: "429", condition: "คำขอเกินอัตราที่กำหนด", message: "กรุณาลองใหม่ภายหลัง" },
        ],
      },
      { id: "verify", kind: "decision", title: "บัญชีและรหัสผ่านถูกต้อง?", description: "ตรวจสถานะบัญชีและเปรียบเทียบ password hash", actor: "Backend", position: { x: 1210, y: 80 } },
      {
        id: "session",
        kind: "action",
        title: "สร้าง Session",
        description: "สร้าง session บันทึก audit และตั้ง cookie ที่ปลอดภัย",
        actor: "Backend",
        position: { x: 1510, y: 20 },
        outputs: [{ name: "session", type: "HttpOnly Cookie", required: true, description: "session สำหรับคำขอถัดไป" }],
        rules: ["Cookie ต้องเป็น HttpOnly, Secure และ SameSite", "บันทึก audit โดยไม่มีข้อมูลลับ"],
      },
      { id: "failure", kind: "end", title: "เข้าสู่ระบบไม่สำเร็จ", description: "ตอบ 401 โดยไม่เปิดเผยว่าอีเมลหรือรหัสผ่านผิด", position: { x: 1510, y: 280 } },
      { id: "success", kind: "end", title: "ไปหน้า Dashboard", description: "ผู้ใช้เข้าสู่ระบบสำเร็จและถูกนำไปหน้า Dashboard", position: { x: 1810, y: 20 } },
    ],
    transitions: [
      { id: "t1", source: "start", target: "input" },
      { id: "t2", source: "input", target: "validate" },
      { id: "t3", source: "validate", target: "request", label: "ถูกต้อง" },
      { id: "t4", source: "validate", target: "failure", label: "ไม่ถูกต้อง" },
      { id: "t5", source: "request", target: "verify" },
      { id: "t6", source: "verify", target: "session", label: "ถูกต้อง" },
      { id: "t7", source: "verify", target: "failure", label: "ไม่ถูกต้อง" },
      { id: "t8", source: "session", target: "success" },
    ],
  };
}
