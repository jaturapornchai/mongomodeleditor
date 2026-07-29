// app/mcp/server.ts — นิยาม MCP server ของ MongoModel + tools ทั้งหมด (แชร์ 2 transport)
// ใช้โดย app/mcp/route.ts (Streamable HTTP) และ mcp-stdio.ts (stdio สำหรับ client ที่ spawn process)
// ทุก tool ต้องระบุ project เสมอ (ทำได้หลาย project พร้อมกัน — ดูรายชื่อด้วย list_projects)
// ทุก mutation บันทึกลง data/projects.json ทันทีผ่าน store (auto save) และเพิ่ม rev ให้ UI auto refresh

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProject,
  saveProject,
  RevConflictError,
  createProject,
  renameProject,
  deleteProject,
  listProjects,
  getWorkspace,
  listRevisions,
  restoreRevision,
  validProjectName,
  type StoredProject,
  type StoredDiagram,
} from "../store";
import {
  FIELD_TYPES,
  type Field,
  type FieldType,
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
  toGo,
  lintModel,
} from "../schema";

// ---------- ชนิดข้อมูล node/edge แบบโครงสร้างตรง UI ----------

type N = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  width?: number;
  data: CollectionData;
};
type E = {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: EdgeRelData;
};

const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- helpers ----------

const ok = (data: unknown) => ({
  content: [
    { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
  ],
});
const err = (message: string) => ({
  content: [{ type: "text" as const, text: `⚠ ${message}` }],
  isError: true,
});

// ---------- กฎคำอธิบายภาษาไทย (บังคับทุก collection/field ที่สร้างผ่าน MCP) ----------

/** มีอักขระไทยอย่างน้อย 1 ตัว (ช่วง Unicode ภาษาไทย) */
const THAI_RE = /[\u0E00-\u0E7F]/;
const isThai = (s: string) => THAI_RE.test(s);

/** มีคำอธิบายภาษาไทยครบไหม */
const hasThaiDesc = (d: string | undefined): boolean =>
  d !== undefined && d.trim() !== "" && isThai(d);

/** description ต้องมีและเป็นภาษาไทย — คืนข้อความ error (พร้อม machine code) หรือ null ถ้าผ่าน */
function thaiDescError(what: string, desc: string | undefined): string | null {
  if (desc === undefined || desc.trim() === "")
    return `[DESCRIPTION_NOT_THAI] ${what} ต้องมี description (คำอธิบาย)`;
  if (!isThai(desc))
    return `[DESCRIPTION_NOT_THAI] ${what} description ต้องเป็นภาษาไทย (อย่างน้อยมีอักขระไทย) — ได้รับ: "${desc}"`;
  return null;
}

/**
 * schema รับ children ลึก 2 ชั้นต่อคำสั่ง (fieldInputSchema → fieldL1) — ชั้นที่ 3 zod ปล่อยผ่านเป็น any
 * จึงต้องดักเองให้ตอบไทย + machine code ชี้ทางหนี (ไม่ปล่อย zod message ดิบ / ไม่ strip ทิ้งเงียบ)
 * เรียกกับทุก array ที่ validate ด้วย z.array(fieldInputSchema)
 */
function fieldsDepthError(fields: FieldInput[], path = ""): string | null {
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    for (const c of f.children ?? []) {
      if (c.children !== undefined && (!Array.isArray(c.children) || c.children.length > 0))
        return `[FIELD_TOO_DEEP] field "${p}.${c.name}" ซ้อนเกิน 2 ชั้นในคำสั่งเดียว — สร้างถึงชั้นนี้ก่อน แล้วเติมชั้นที่ลึกกว่าด้วย add_field พร้อม parent แบบ dotted path (เช่น parent: "${p}.${c.name}")`;
    }
  }
  return null;
}

/** ตรวจทุก field (recursive ลง children) ว่ามีคำอธิบายไทยครบ */
function fieldsThaiError(fields: FieldInput[], path = ""): string | null {
  for (const f of fields) {
    const p = path ? `${path}.${f.name}` : f.name;
    const e = thaiDescError(`field "${p}"`, f.description);
    if (e) return e;
    if (f.children) {
      const ce = fieldsThaiError(f.children, p);
      if (ce) return ce;
    }
  }
  return null;
}

/** โหลด project หรือคืนข้อความ error พร้อมรายชื่อที่มี */
async function requireProject(name: string): Promise<StoredProject | { error: string }> {
  const p = await getProject(name);
  if (p) return p;
  const ws = await getWorkspace();
  const choices = Object.keys(ws.projects).map((n) => `"${n}"`).join(", ") || "(ยังไม่มี project — สร้างด้วย create_project)";
  return { error: `[PROJECT_NOT_FOUND] ไม่พบ project "${name}" — ที่มีอยู่: ${choices}` };
}

// ส่ง p.rev เป็น expectedRev เสมอ — mutation ทุกตัวอ่าน (requireProject) แล้วเขียนนอก critical section
// ถ้าไม่เช็ค rev การยิง tool ขนานกันจะทับกันหายเงียบ (last-write-wins) ทั้งที่ทุก response ตอบ success
const save = (project: string, p: StoredProject) =>
  saveProject(project, { tabs: p.tabs, cur: p.cur, diagrams: p.diagrams }, p.rev);

/**
 * ห่อ handler ของ mutation tool: save() ชน rev (มีคนเขียนแทรกระหว่างอ่าน-เขียน) → รัน handler ใหม่ทั้งตัว
 * (requireProject อ่าน state ล่าสุด + ทำ mutation ซ้ำ) — โปร่งใสกับ client, กัน lost update ตอนยิงขนาน
 */
// ponytail: optimistic retry ทั้ง handler (เพดาน 30 รอบ ครอบเคสยิงขนานหลักสิบ) — ถ้า contention สูงกว่านั้นค่อยย้าย read-modify-write เข้าคิวเขียนใน store
const withRetry =
  <A, X, R>(fn: (args: A, extra: X) => R | Promise<R>) =>
  async (args: A, extra: X): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(args, extra);
      } catch (e) {
        if (!(e instanceof RevConflictError) || attempt >= 30) throw e;
      }
    }
  };

/** หา diagram จาก id หรือชื่อ (ไม่ส่ง = diagram ปัจจุบัน) */
function findDiagram(
  p: StoredProject,
  ref: string | undefined
): { id: string; d: StoredDiagram; name: string } | { error: string } {
  const id = ref ?? p.cur;
  if (p.diagrams[id]) {
    return { id, d: p.diagrams[id], name: p.tabs.find((t) => t.id === id)?.name ?? id };
  }
  const byName = p.tabs.find((t) => t.name === ref);
  if (byName && p.diagrams[byName.id]) {
    return { id: byName.id, d: p.diagrams[byName.id], name: byName.name };
  }
  const choices = p.tabs.map((t) => `"${t.name}" (${t.id})`).join(", ") || "(ไม่มี diagram)";
  return { error: `[DIAGRAM_NOT_FOUND] ไม่พบ diagram "${ref}" — ที่มีอยู่: ${choices}` };
}

/** หา collection จาก node id หรือ label */
function findNode(d: StoredDiagram, ref: string): N | { error: string } {
  const nodes = d.nodes as N[];
  const hit = nodes.find((n) => n.id === ref) ?? nodes.find((n) => n.data.label === ref);
  if (!hit) {
    const choices = nodes.map((n) => n.data.label).join(", ") || "(ไม่มี collection)";
    return { error: `[COLLECTION_NOT_FOUND] ไม่พบ collection "${ref}" — ที่มีอยู่: ${choices}` };
  }
  return hit;
}

/**
 * หา field จาก id หรือ dotted path ของชื่อ (เช่น "address.geo.lat") — คืน array ที่ field อยู่
 * เพื่อให้ caller push/splice ได้ตรงๆ
 */
function findField(
  fields: Field[],
  ref: string
): { container: Field[]; field: Field } | { error: string } {
  const byId = fields.find((f) => f.id === ref);
  if (byId) return { container: fields, field: byId };
  const parts = ref.split(".");
  let container = fields;
  for (let i = 0; i < parts.length; i++) {
    const f = container.find((x) => x.name === parts[i]);
    if (!f) return { error: `[FIELD_NOT_FOUND] ไม่พบ field "${ref}" (ติดที่ "${parts[i]}")` };
    if (i === parts.length - 1) return { container, field: f };
    if (!f.children) return { error: `[FIELD_NOT_FOUND] field "${parts[i]}" ไม่มีฟิลด์ย่อย` };
    container = f.children;
  }
  return { error: `[FIELD_NOT_FOUND] ไม่พบ field "${ref}"` };
}

/**
 * กวาดเส้นในทุก diagram ที่ยังชี้ node id ที่หายไป (เส้นข้าม tab เก็บใน diagram ต้นทาง = tab อื่นถือเส้นชี้มาได้)
 * ใช้ทุกจุดที่ node หาย/ถูกแทนที่ id ใหม่ (delete_collection/delete_diagram/replace_diagram/add_collection replace)
 * — คืนจำนวนเส้นที่ลบ เพื่อรายงานใน response (ห้ามลบเงียบ)
 */
function dropEdgesTouching(p: StoredProject, ids: Set<string>): number {
  let removed = 0;
  for (const dd of Object.values(p.diagrams)) {
    const before = (dd.edges as E[]).length;
    dd.edges = (dd.edges as E[]).filter((e) => !ids.has(e.source) && !ids.has(e.target));
    removed += before - (dd.edges as E[]).length;
  }
  return removed;
}

/** pin field ระดับบนที่ติดธง key ขึ้นต่อท้ายกลุ่ม key ด้านบน (PK/_id → key เดิม → ตัวใหม่) — ไม่เรียงกลุ่มเดิมใหม่ */
function pinKeyField(container: Field[], field: Field): void {
  const isKey = (x: Field) => Boolean(x.key || x.sessionkey || x.keygroup || x.name === "_id");
  container.splice(container.indexOf(field), 1);
  let last = -1;
  container.forEach((x, i) => {
    if (isKey(x)) last = i;
  });
  container.splice(last + 1, 0, field);
}

type FieldInput = {
  name: string;
  type: FieldType;
  required?: boolean;
  description: string; // บังคับ — ต้องเป็นภาษาไทย (ตรวจด้วย fieldsThaiError)
  of?: FieldType;
  enum?: string[];
  default?: string;
  unique?: boolean;
  bounded?: boolean;
  key?: boolean;
  sessionkey?: boolean;
  keygroup?: string;
  keygroupunique?: boolean;
  children?: FieldInput[];
};

const toField = (input: FieldInput): Field => ({
  id: uid(),
  name: input.name,
  type: input.type,
  required: input.required ?? false,
  description: input.description,
  ...(input.of !== undefined && { of: input.of }),
  ...(input.enum !== undefined && { enum: input.enum }),
  ...(input.default !== undefined && { default: input.default }),
  ...(input.unique !== undefined && { unique: input.unique }),
  ...(input.bounded !== undefined && { bounded: input.bounded }),
  ...(input.key !== undefined && { key: input.key }),
  ...(input.sessionkey !== undefined && { sessionkey: input.sessionkey }),
  ...(input.keygroup !== undefined && input.keygroup !== "" && { keygroup: input.keygroup }),
  ...(input.keygroupunique !== undefined && { keygroupunique: input.keygroupunique }),
  ...(input.children !== undefined && { children: input.children.map(toField) }),
});

const toGenNode = (n: N): GenNode => ({ id: n.id, data: n.data });
const toGenEdge = (e: E): GenEdge => ({
  source: e.source,
  sourceHandle: e.sourceHandle,
  target: e.target,
  targetHandle: e.targetHandle,
  data: e.data,
});

// ---------- zod schemas ----------

const projectParam = z
  .string()
  .min(1)
  .describe("ชื่อ project (บังคับเสมอ — ดูรายชื่อด้วย list_projects)");
const diagramParam = z
  .string()
  .optional()
  .describe("id หรือชื่อของ diagram (ไม่ส่ง = diagram ปัจจุบัน)");
const collectionParam = z.string().describe("node id หรือ label ของ collection");

// zod schema ของ field — ห้าม recursive (getter วนตัวเอง): JSON Schema ที่แปลงออกมาจะมี $ref ชี้ path ตรง
// (#/properties/...) ซึ่ง client บางตัวปฏิเสธทั้งชุด tools (Moonshot บังคับ #/$defs/ เท่านั้น, OpenAI strict ไม่รับ $ref เลย)
// → นิยาม children ลึกจำกัด 2 ชั้นแบบ inline ไม่มี $ref (ลึกกว่านี้ค่อยเติมทีละชั้นด้วย add_field + parent — ดัก [FIELD_TOO_DEEP])
// runtime (toField/fieldsThaiError) ยัง recurse ได้ไม่จำกัดตาม type FieldInput — จำกัดเฉพาะ schema ที่ validate input

// ข้อความเพดาน — zod error ต้องเป็นไทย + machine code เหมือน error อื่นทั้งระบบ (กฎใน AGENTS.md)
const LIMIT_NAME = { error: "[VALUE_TOO_LONG] ข้อความยาวเกิน 200 ตัวอักษร — ใช้ชื่อสั้นลง แล้วเก็บรายละเอียดไว้ใน description" };
const LIMIT_FIELDS = { error: "[TOO_MANY_FIELDS] fields เกิน 300 รายการต่อคำสั่ง — แบ่งส่งเป็นหลายครั้งด้วย add_field" };
const LIMIT_COLLECTIONS = { error: "[TOO_MANY_COLLECTIONS] collections เกิน 200 รายการต่อคำสั่ง — แบ่ง diagram หรือส่งเป็นหลายครั้ง" };
const LIMIT_RELATIONS = { error: "[TOO_MANY_RELATIONS] relations เกิน 500 รายการต่อคำสั่ง — แบ่งส่งเป็นหลายครั้งด้วย add_relation" };

const fieldShape = {
  name: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อฟิลด์"),
  type: z.enum(FIELD_TYPES).describe("ชนิดข้อมูล"),
  required: z.boolean().optional(),
  description: z.string().min(1).describe("คำอธิบายฟิลด์ (บังคับ — ต้องเป็นภาษาไทย)"),
  of: z.enum(FIELD_TYPES).optional().describe("ชนิดสมาชิก (เฉพาะ type=Array)"),
  enum: z.array(z.string()).optional().describe("ค่าที่อนุญาต"),
  default: z.string().optional().describe("ค่าเริ่มต้น (string เสมอ)"),
  unique: z.boolean().optional(),
    bounded: z.boolean().optional().describe("array ของ object: ยืนยันว่ามีขอบเขตแล้ว (linter ไม่เตือนเพดาน 16MB)"),
  key: z.boolean().optional().describe("business key — field ที่ collection อื่นใช้อ้างอิง (แสดง 🔑)"),
  sessionkey: z.boolean().optional().describe("session/tenant scope key เช่น holdingcode (แสดง 🌐)"),
  keygroup: z.string().max(200, LIMIT_NAME).optional().describe("id กลุ่ม key ผสม — fields ที่มี keygroup เดียวกันรวมเป็น key เดียว (compound unique index เช่น holdingcode+itemcode+barcode; แสดง ⛓) — ส่งสตริงว่างเพื่อออกจากกลุ่ม"),
  keygroupunique: z.boolean().optional().describe("กลุ่ม key ผสมห้ามซ้ำ (default true = compound unique index) — false = compound index ธรรมดา ซ้ำได้ เพื่อค้นเร็ว"),
};
const childrenDesc =
  "ฟิลด์ย่อย (type=Object หรือ Array<Object>) — ซ้อนได้ 2 ชั้นต่อคำสั่ง ลึกกว่านั้นใช้ add_field พร้อม parent แบบ dotted path (เช่น parent: \"address.geo\")";
// ชั้นที่ 2 ประกาศ children เป็น array อะไรก็ได้ (ไม่ให้ zod strip ทิ้งเงียบ) แล้ว fieldsDepthError ดักตอบไทยเอง
const fieldL1 = z.object({
  ...fieldShape,
  children: z
    .array(z.any())
    .max(300, LIMIT_FIELDS)
    .optional()
    .describe("ห้ามซ้อนชั้นที่ 3 ในคำสั่งเดียว — เพิ่มชั้นลึกด้วย add_field พร้อม parent แบบ dotted path"),
});
const fieldInputSchema = z.object({
  ...fieldShape,
  children: z.array(fieldL1).max(300, LIMIT_FIELDS).optional().describe(childrenDesc),
});

// ---------- annotations (hint ให้ client ตัดสิน auto-approve) ----------
// ไม่ใส่ = spec default destructiveHint:true + openWorldHint:true ทุกตัว (client มองว่าอันตรายเท่า delete)
// ห้ามใส่เหมา — readOnlyHint ผิดตัว = client auto-approve ของที่ mutate

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const; // เพิ่มของใหม่
const WRITE_IDEM = { ...WRITE, idempotentHint: true } as const; // แก้ของเดิม ยิงซ้ำผลเท่าเดิม
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const; // ลบ/เขียนทับของเดิม

// ---------- server instructions (client เห็นตอน initialize — Claude Code ตัดที่ 2KB ห้ามยาวเกิน 2048 ตัวอักษร) ----------

const INSTRUCTIONS = `MongoModel — เครื่องมือออกแบบ schema MongoDB เป็นผัง ER (project → diagram → collection → field → relation) เก็บในไฟล์ของแอปเอง ไม่แตะฐานข้อมูลจริง
กฎบังคับ:
1. ทุก tool ต้องส่ง project (ชื่อโปรเจกต์) เสมอ — ดูรายชื่อด้วย list_projects
2. description ของทุก collection/field บังคับภาษาไทย (มีอักขระไทยอย่างน้อย 1 ตัว) — เช็กจุดที่ขาดด้วย check_descriptions
3. relation เป็น field→field เสมอ และต้องอ้าง business key ของฝั่งแม่ (เช่น code, holdingcode) ห้ามอ้าง guidfixed (identity ภายใน ไม่พกพาข้ามเครื่อง) — ทิศแม่→ลูก (ฝั่งลูกถือ FK)
4. field ซ้อน (children) รับลึก 2 ชั้นต่อคำสั่ง — ลึกกว่านั้นใช้ add_field พร้อม parent แบบ dotted path
5. สร้างผังใหม่ทั้งก้อนใช้ replace_diagram (ระวัง: เขียนทับทั้ง diagram); แก้ทีละจุดใช้ add_*/update_*/delete_*
Workflow แนะนำ: list_projects → list_diagrams → get_diagram (detail:"summary" ประหยัดโทเคน) → แก้ไข → check_descriptions + lint_model → generate_code (mongosh/go/mongoose/typescript/markdown/sample/json/wiki)
ทุก mutation บันทึกอัตโนมัติ (UI ผู้ใช้ refresh เอง) — แก้พลาดย้อนได้ด้วย list_revisions + restore_revision · error ทุกตัวมี machine code นำหน้า เช่น [PROJECT_NOT_FOUND]`;

// ---------- สร้าง server + ลงทะเบียน tools ----------

export function createServer(): McpServer {
  const server = new McpServer({ name: "mongomodel", version: "2.0.0" }, { instructions: INSTRUCTIONS });

  // ----- จัดการ project -----

  server.registerTool(
    "list_projects",
    {
      title: "ดูรายชื่อโปรเจกต์",
      description: "แสดงรายการ project ทั้งหมด (ชื่อ, จำนวน diagram/collection, เวลาแก้ล่าสุด)",
      annotations: READ,
    },
    async () => ok(await listProjects())
  );

  server.registerTool(
    "create_project",
    {
      title: "สร้างโปรเจกต์",
      description: "สร้าง project ใหม่ (ว่าง มี Main Diagram ให้)",
      inputSchema: { name: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อ project — ห้ามซ้ำกับที่มีอยู่") },
      annotations: WRITE,
    },
    async ({ name }) => {
      if (!validProjectName(name)) return err("[INVALID_PROJECT_NAME] ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)");
      try {
        await createProject(name.trim());
        return ok({ name: name.trim() });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    "rename_project",
    {
      title: "เปลี่ยนชื่อโปรเจกต์",
      description: "เปลี่ยนชื่อ project",
      inputSchema: { project: projectParam, name: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อใหม่") },
      annotations: WRITE_IDEM,
    },
    async ({ project, name }) => {
      if (!validProjectName(name)) return err("[INVALID_PROJECT_NAME] ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)");
      try {
        await renameProject(project, name.trim());
        return ok({ name: name.trim() });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    "list_revisions",
    {
      title: "ดูรายการ snapshot",
      description:
        "แสดง snapshot ของ workspace ที่ระบบเก็บอัตโนมัติก่อนการเขียนทุกครั้ง (ใหม่สุดก่อน) ใช้ดูว่าย้อนกลับไปจุดไหนได้บ้าง",
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const revs = await listRevisions();
      return ok(revs.length ? revs : "ยังไม่มี snapshot");
    }
  );

  server.registerTool(
    "restore_revision",
    {
      title: "ย้อนกลับ snapshot",
      description:
        "ย้อน workspace ทั้งชุด (ทุก project) กลับไปที่ snapshot ที่ระบุ — ของปัจจุบันถูก snapshot ไว้ก่อนเสมอจึงย้อนกลับมาได้อีก ใช้เมื่อแก้พลาดจนโมเดลเสียหาย",
      inputSchema: { rev: z.number().int().describe("เลข rev จาก list_revisions") },
      annotations: DESTRUCTIVE,
    },
    async ({ rev }) => {
      try {
        const r = await restoreRevision(rev);
        return ok(`ย้อนกลับไป rev ${rev} แล้ว (rev ใหม่ ${r.rev}) — project: ${r.projects.join(", ")}`);
      } catch (e) {
        // ENOENT = ไม่มีไฟล์ snapshot — ห้ามคาย path ของเครื่องออกไปกับ error ดิบ
        if ((e as { code?: string }).code === "ENOENT")
          return err(`[REVISION_NOT_FOUND] ไม่พบ snapshot rev ${rev} — ดูรายการที่มีด้วย list_revisions`);
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_project",
    {
      title: "ลบโปรเจกต์",
      description: "ลบ project ถาวร (ทุก diagram ในนั้นหายหมด)",
      inputSchema: { project: projectParam },
      annotations: DESTRUCTIVE,
    },
    async ({ project }) => {
      try {
        await deleteProject(project);
        return ok(`ลบ project "${project}" แล้ว`);
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ----- อ่าน -----

  server.registerTool(
    "list_diagrams",
    {
      title: "ดูรายชื่อ diagram",
      description: "แสดงรายการ diagram ทั้งหมดใน project (id, ชื่อ, จำนวน collection, อันที่กำลังเปิด)",
      inputSchema: { project: projectParam },
      annotations: READ,
    },
    async ({ project }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      return ok(
        p.tabs.map((t) => ({
          id: t.id,
          name: t.name,
          collections: (p.diagrams[t.id]?.nodes.length ?? 0) as number,
          current: t.id === p.cur,
        }))
      );
    }
  );

  server.registerTool(
    "get_diagram",
    {
      title: "อ่านผัง",
      description:
        "อ่าน diagram (nodes = collection พร้อม fields, edges = ความสัมพันธ์) — detail:\"summary\" คืนโครงย่อสำหรับ LLM (ตัด position/width/handle/edge id; เหลือ node id + label + description + fields + relations แบบ \"A.field → B.field\") ประหยัดโทเคนมาก · ไม่ส่งหรือ \"full\" = ก้อนเต็มเหมือนเดิม (ใช้เมื่อต้องการตำแหน่ง/handle/edge id ดิบ)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("summary = โครงย่อประหยัดโทเคน (แนะนำสำหรับอ่านทำความเข้าใจ) · ไม่ส่ง = full"),
      },
      annotations: READ,
      _meta: { "anthropic/maxResultSizeChars": 200000 },
    },
    async ({ project, diagram, detail }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      if (detail !== "summary")
        return ok({ id: hit.id, name: hit.name, nodes: hit.d.nodes, edges: hit.d.edges });
      // summary: ตัด position/width/handle/edge id — คง node id ไว้เสมอ (agent ต้องใช้อ้างตอน update_*)
      const summarizeField = (f: Field): Record<string, unknown> => ({
        name: f.name,
        type: f.type,
        ...(f.of !== undefined && { of: f.of }),
        ...(f.required && { required: true }),
        ...(f.unique && { unique: true }),
        ...(f.key && { key: true }),
        ...(f.sessionkey && { sessionkey: true }),
        ...(f.keygroup !== undefined && { keygroup: f.keygroup }),
        ...(f.keygroupunique !== undefined && { keygroupunique: f.keygroupunique }),
        ...(f.enum !== undefined && { enum: f.enum }),
        ...(f.default !== undefined && { default: f.default }),
        description: f.description,
        ...(f.children && { children: f.children.map(summarizeField) }),
      });
      // เส้นข้าม tab ชี้ node ใน diagram อื่นได้ — resolve label/ชื่อ field จากทุก diagram
      const nodeById = new Map(
        Object.values(p.diagrams).flatMap((d) => (d.nodes as N[]).map((n) => [n.id, n] as const))
      );
      const fieldName = (n: N | undefined, handle: string | null | undefined): string => {
        if (!n || !handle) return "?";
        const fid = handle.replace(/-[st](-[lr])?$/, "");
        const walk = (fs: Field[]): string | null => {
          for (const f of fs) {
            if (f.id === fid) return f.name;
            if (f.children) {
              const r = walk(f.children);
              if (r) return r;
            }
          }
          return null;
        };
        return walk(n.data.fields) ?? handle;
      };
      const relations = (hit.d.edges as E[]).map((e) => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        return {
          rel: `${s?.data.label ?? e.source}.${fieldName(s, e.sourceHandle)} → ${t?.data.label ?? e.target}.${fieldName(t, e.targetHandle)}`,
          ...(e.data?.kind !== undefined && { kind: e.data.kind }),
          ...(e.data?.cardinality !== undefined && { cardinality: e.data.cardinality }),
        };
      });
      return ok({
        id: hit.id,
        name: hit.name,
        collections: (hit.d.nodes as N[]).map((n) => ({
          id: n.id,
          label: n.data.label,
          description: n.data.description,
          fields: n.data.fields.map(summarizeField),
        })),
        relations,
      });
    }
  );

  server.registerTool(
    "lint_model",
    {
      title: "ตรวจโมเดล",
      description:
        "ตรวจโมเดลด้วยกฎที่เครื่องจับได้: ฟิลด์เงินที่ยังเป็น Number (ควร Decimal128), unique บนฟิลด์ที่ไม่ required (ชนกันที่ null), สมาชิก key ผสมห้ามซ้ำที่ไม่ required, FK ที่ชนิดไม่ตรงกับปลายทาง, collection ที่มี FK แต่ไม่มี session key (index ไม่ scope ตามผู้เช่า), array ที่ไม่รู้ shape / ไม่มีขอบเขต, และ shape ของ array *names — ไม่ระบุ diagram = ตรวจทั้ง project",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        level: z
          .enum(["all", "error"])
          .optional()
          .describe("error = เอาเฉพาะที่ทำให้ผลลัพธ์ผิดจริง (default all)"),
      },
      annotations: READ,
    },
    async ({ project, diagram, level }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const allNodes = Object.values(p.diagrams).flatMap((d) => (d.nodes ?? []) as unknown as GenNode[]);
      let targets: [string, StoredDiagram][];
      if (diagram === undefined) {
        targets = Object.entries(p.diagrams);
      } else {
        const hit = findDiagram(p, diagram);
        if ("error" in hit) return err(hit.error); // มี [DIAGRAM_NOT_FOUND] + รายชื่อที่มีอยู่แล้ว
        targets = [[hit.id, hit.d]];
      }
      const out = [];
      for (const [id, d] of targets) {
        const name = p.tabs.find((t) => t.id === id)?.name ?? id;
        let issues = lintModel(
          (d.nodes ?? []) as unknown as GenNode[],
          (d.edges ?? []) as unknown as GenEdge[],
          allNodes,
        );
        if (level === "error") issues = issues.filter((i) => i.level === "error");
        if (issues.length) out.push({ diagram: name, issues });
      }
      const total = out.reduce((n, x) => n + x.issues.length, 0);
      return ok(total === 0 ? "ไม่พบปัญหา" : { total, diagrams: out });
    }
  );

  server.registerTool(
    "check_descriptions",
    {
      title: "ตรวจคำอธิบายไทย",
      description:
        "ตรวจว่า collection/field ไหนยังไม่มีคำอธิบายภาษาไทย — คืนรายการ path ที่ต้องไปเติม (ว่าง = ครบแล้ว) ใช้ก่อน generate_code เพื่อให้เอกสารออกมามีคำอธิบายไทยครบ",
      inputSchema: { project: projectParam, diagram: diagramParam },
      annotations: READ,
    },
    async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const missing: string[] = [];
      const walk = (collLabel: string, fields: Field[], path: string) => {
        for (const f of fields) {
          const fp = path ? `${path}.${f.name}` : f.name;
          if (!hasThaiDesc(f.description)) missing.push(`${collLabel}.${fp}`);
          if (f.children) walk(collLabel, f.children, fp);
        }
      };
      for (const n of hit.d.nodes as N[]) {
        if (!hasThaiDesc(n.data.description)) missing.push(n.data.label);
        walk(n.data.label, n.data.fields, "");
      }
      return missing.length === 0
        ? ok("✓ ครบ — ทุก collection/field มีคำอธิบายภาษาไทยแล้ว")
        : ok({
            count: missing.length,
            missing,
            hint: "เติมด้วย update_collection / update_field พร้อม description ภาษาไทย",
          });
    }
  );

  // ----- จัดการ diagram -----

  server.registerTool(
    "create_diagram",
    {
      title: "สร้าง diagram",
      description: "สร้าง diagram ใหม่ (ว่าง) แล้วสลับไปที่มัน",
      inputSchema: { project: projectParam, name: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อ diagram") },
      annotations: WRITE,
    },
    withRetry(async ({ project, name }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const id = uid();
      p.tabs.push({ id, name });
      p.diagrams[id] = { nodes: [], edges: [] };
      p.cur = id;
      await save(project, p);
      return ok({ id, name });
    })
  );

  server.registerTool(
    "rename_diagram",
    {
      title: "เปลี่ยนชื่อ diagram",
      description: "เปลี่ยนชื่อ diagram",
      inputSchema: { project: projectParam, diagram: diagramParam, name: z.string().min(1).max(200, LIMIT_NAME) },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, diagram, name }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const tab = p.tabs.find((t) => t.id === hit.id);
      if (tab) tab.name = name;
      await save(project, p);
      return ok({ id: hit.id, name });
    })
  );

  server.registerTool(
    "delete_diagram",
    {
      title: "ลบ diagram",
      description: "ลบ diagram ถาวร (ถ้าเหลือ 0 จะสร้าง Main Diagram ว่างให้)",
      inputSchema: { project: projectParam, diagram: diagramParam },
      annotations: DESTRUCTIVE,
    },
    withRetry(async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      p.tabs = p.tabs.filter((t) => t.id !== hit.id);
      delete p.diagrams[hit.id];
      // เส้นข้าม tab จาก diagram อื่นที่ชี้เข้ามา diagram ที่ถูกลบ — เก็บกวาดด้วย
      dropEdgesTouching(p, new Set((hit.d.nodes as N[]).map((n) => n.id)));
      if (!p.tabs.length) {
        const id = uid();
        p.tabs = [{ id, name: "Main Diagram" }];
        p.diagrams[id] = { nodes: [], edges: [] };
      }
      if (p.cur === hit.id || !p.diagrams[p.cur]) p.cur = p.tabs[0].id;
      await save(project, p);
      return ok(`ลบ "${hit.name}" แล้ว`);
    })
  );

  server.registerTool(
    "switch_diagram",
    {
      title: "สลับ diagram",
      description: "สลับ diagram ปัจจุบัน (อันที่ UI กำลังเปิด / default ของ tools อื่น)",
      inputSchema: { project: projectParam, diagram: diagramParam },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      p.cur = hit.id;
      await save(project, p);
      return ok({ current: hit.id, name: hit.name });
    })
  );

  // ----- จัดการ collection -----

  server.registerTool(
    "add_collection",
    {
      title: "เพิ่ม/แทนที่ collection",
      description:
        "เพิ่ม collection ใหม่ — description บังคับต้องเป็นภาษาไทย (ทั้ง collection และทุก field ถ้าส่ง fields; เรียก check_descriptions เพื่อเช็กจุดที่ยังขาดได้) · ถ้าไม่ส่ง fields จะใส่ _id: ObjectId (PK) พร้อมคำอธิบายไทยให้อัตโนมัติ · label ซ้ำใน diagram เดียวกันถูกปฏิเสธ (เว้นแต่ replace: true)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        label: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อ collection — ห้ามซ้ำใน diagram เดียวกัน"),
        description: z
          .string()
          .min(1)
          .describe("คำอธิบาย collection (บังคับ — ต้องเป็นภาษาไทย)"),
        replace: z
          .boolean()
          .optional()
          .describe("true = แทนที่ collection ชื่อซ้ำเดิม (ลบของเก่าพร้อมเส้นที่เกี่ยว)"),
        x: z.number().optional().describe("ตำแหน่งบน canvas (default ไล่ลงขวา)"),
        y: z.number().optional(),
        fields: z
          .array(fieldInputSchema)
          .max(300, LIMIT_FIELDS)
          .optional()
          .describe("ฟิลด์เริ่มต้น — ทุก field ต้องมี description ภาษาไทย (รวม children)"),
      },
      annotations: DESTRUCTIVE, // replace: true ลบของเก่าพร้อมเส้นที่เกี่ยว
    },
    withRetry(async ({ project, diagram, label, description, replace, x, y, fields }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      // label ซ้ำ — ปฏิเสธเว้นแต่ส่ง replace: true
      const dup = (hit.d.nodes as N[]).find((n) => n.data.label === label);
      if (dup && !replace) {
        return err(
          `[DUPLICATE_LABEL] collection "${label}" มีอยู่แล้วใน diagram นี้ — ส่ง replace: true เพื่อแทนที่ หรือใช้ชื่ออื่น`
        );
      }
      // บังคับคำอธิบายไทย — collection และทุก field (recursive)
      const collErr = thaiDescError(`collection "${label}"`, description);
      if (collErr) return err(collErr);
      if (fields) {
        const fErr = fieldsThaiError(fields) ?? fieldsDepthError(fields);
        if (fErr) return err(fErr);
      }
      let position = { x: x ?? 0, y: y ?? 0 };
      let edgesRemoved = 0;
      if (dup) {
        // แทนที่: ลบ node เดิม + เส้นที่เกี่ยวใน "ทุก" diagram (tab อื่นถือเส้นข้าม tab ชี้ id เก่าได้) คงตำแหน่งเดิมไว้
        position = { x: x ?? dup.position.x, y: y ?? dup.position.y };
        hit.d.nodes = (hit.d.nodes as N[]).filter((n) => n.id !== dup.id);
        edgesRemoved = dropEdgesTouching(p, new Set([dup.id]));
      }
      const nodes = hit.d.nodes as N[];
      const count = nodes.length;
      if (!dup) position = { x: x ?? 120 + count * 40, y: y ?? 120 + count * 40 };
      const node: N = {
        id: uid(),
        type: "collection",
        position,
        data: {
          label,
          description,
          fields:
            fields?.map(toField) ??
            [
              {
                id: uid(),
                name: "_id",
                type: "ObjectId",
                required: true,
                description: "รหัส ObjectID ของเอกสาร",
              },
            ],
        },
      };
      nodes.push(node);
      await save(project, p);
      return ok({
        id: node.id,
        label,
        replaced: dup !== undefined,
        // รายงานเส้นที่ถูกลบตอน replace เสมอ (ห้ามลบเงียบ — เส้นข้าม tab จาก diagram อื่นก็โดนกวาดด้วย)
        ...(dup !== undefined && { edgesRemoved }),
      });
    })
  );

  server.registerTool(
    "update_collection",
    {
      title: "แก้ collection",
      description: "แก้ชื่อ / คำอธิบาย collection — หลังแก้ collection ต้องมีคำอธิบายภาษาไทยเสมอ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        label: z.string().min(1).max(200, LIMIT_NAME).optional(),
        description: z.string().optional().describe("ต้องเป็นภาษาไทย (ลบคำอธิบายเดิมไม่ได้)"),
      },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, diagram, collection, label, description }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      const newLabel = label ?? node.data.label;
      const newDesc = description !== undefined && description !== "" ? description : node.data.description;
      // หลังแก้ต้องเหลือคำอธิบายไทยเสมอ — ถ้ายังไม่มีให้ส่ง description ภาษาไทยมาด้วย
      const dErr = thaiDescError(`collection "${newLabel}"`, newDesc);
      if (dErr) return err(dErr);
      node.data.label = newLabel;
      node.data.description = newDesc;
      await save(project, p);
      return ok({ id: node.id, label: node.data.label });
    })
  );

  server.registerTool(
    "delete_collection",
    {
      title: "ลบ collection",
      description: "ลบ collection พร้อมเส้นความสัมพันธ์ที่เกี่ยวข้องทั้งหมด (รวมเส้นข้าม tab ที่ชี้มาหามัน)",
      inputSchema: { project: projectParam, diagram: diagramParam, collection: collectionParam },
      annotations: DESTRUCTIVE,
    },
    withRetry(async ({ project, diagram, collection }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      hit.d.nodes = (hit.d.nodes as N[]).filter((n) => n.id !== node.id);
      // ลบเส้นที่เกี่ยวในทุก diagram (เส้นข้าม tab จาก tab อื่นชี้มาหาตัวนี้ด้วย)
      const edgesRemoved = dropEdgesTouching(p, new Set([node.id]));
      await save(project, p);
      return ok(`ลบ collection "${node.data.label}" แล้ว (ลบเส้นที่เกี่ยว ${edgesRemoved} เส้น)`);
    })
  );

  server.registerTool(
    "move_collection",
    {
      title: "ย้าย collection ข้าม tab",
      description:
        "ย้าย collection ไป diagram อื่นในโปรเจกต์เดียวกัน — node id คงเดิม เส้นเดิมกลายเป็นข้าม tab อัตโนมัติ (ใช้แยกโซน master/transaction/types เป็นคนละ tab)",
      inputSchema: {
        project: projectParam,
        collection: collectionParam.describe("node id หรือ label ของ collection ที่จะย้าย (ค้นจากทุก diagram)"),
        to: z.string().describe("id หรือชื่อของ diagram ปลายทาง"),
      },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, collection, to }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      // หา diagram ปลายทางก่อน (ต้องมีอยู่)
      const dest = findDiagram(p, to);
      if ("error" in dest) return err(dest.error);
      // หา collection จากทุก diagram
      let fromId = "";
      let node: N | null = null;
      for (const [did, dd] of Object.entries(p.diagrams)) {
        const hit = findNode(dd, collection);
        if (!("error" in hit)) {
          fromId = did;
          node = hit;
          break;
        }
      }
      if (!node) return err(`[COLLECTION_NOT_FOUND] ไม่พบ collection "${collection}" ในทุก diagram`);
      if (fromId === dest.id) return err(`[DUPLICATE_LABEL] collection "${node.data.label}" อยู่ใน diagram ปลายทางแล้ว`);
      if ((dest.d.nodes as N[]).some((n) => n.data.label === node.data.label)) {
        return err(`[DUPLICATE_LABEL] diagram ปลายทางมี collection "${node.data.label}" อยู่แล้ว`);
      }
      const from = p.diagrams[fromId];
      from.nodes = (from.nodes as N[]).filter((n) => n.id !== node.id);
      const count = (dest.d.nodes as N[]).length;
      node.position = { x: 120 + count * 40, y: 120 + count * 40 };
      (dest.d.nodes as N[]).push(node);
      await save(project, p);
      return ok({
        moved: node.data.label,
        from: p.tabs.find((t) => t.id === fromId)?.name ?? fromId,
        to: dest.name,
        note: "เส้นความสัมพันธ์เดิมยังอยู่ — กลายเป็นเส้นข้าม tab โดยอัตโนมัติ",
      });
    })
  );

  // ----- จัดการ field -----

  server.registerTool(
    "add_field",
    {
      title: "เพิ่มฟิลด์",
      description:
        "เพิ่มฟิลด์ใน collection — description บังคับต้องเป็นภาษาไทย (รวม children; เรียก check_descriptions เพื่อเช็กจุดที่ยังขาดได้) · ซ้อนได้ด้วย parent (dotted path ไปยัง Object/Array<Object>)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        parent: z
          .string()
          .optional()
          .describe("dotted path ของฟิลด์แม่ (เช่น \"address.geo\") — ไม่ส่ง = ฟิลด์ระดับบน"),
        name: z.string().min(1).max(200, LIMIT_NAME),
        type: z.enum(FIELD_TYPES),
        required: z.boolean().optional(),
        description: z.string().min(1).describe("คำอธิบายฟิลด์ (บังคับ — ต้องเป็นภาษาไทย)"),
        of: z.enum(FIELD_TYPES).optional(),
        enum: z.array(z.string()).optional(),
        default: z.string().optional(),
        unique: z.boolean().optional(),
    bounded: z.boolean().optional().describe("array ของ object: ยืนยันว่ามีขอบเขตแล้ว (linter ไม่เตือนเพดาน 16MB)"),
        key: z.boolean().optional().describe("business key — field ที่ collection อื่นใช้อ้างอิง (แสดง 🔑)"),
        sessionkey: z.boolean().optional().describe("session/tenant scope key เช่น holdingcode (แสดง 🌐)"),
        keygroup: z.string().max(200, LIMIT_NAME).optional().describe("id กลุ่ม key ผสม — fields ที่มี keygroup เดียวกันรวมเป็น key เดียว (compound unique index; แสดง ⛓)"),
        keygroupunique: z.boolean().optional().describe("กลุ่ม key ผสมห้ามซ้ำ (default true) — false = compound index ธรรมดา ซ้ำได้"),
        children: z.array(fieldInputSchema).max(300, LIMIT_FIELDS).optional().describe(childrenDesc),
      },
      annotations: WRITE,
    },
    withRetry(async ({ project, diagram, collection, parent, ...input }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      // บังคับคำอธิบายไทย — ฟิลด์นี้และ children ทั้งหมด + คุมความลึก children ต่อคำสั่ง
      const fErr =
        fieldsThaiError([input as FieldInput]) ??
        fieldsDepthError((input as FieldInput).children ?? [], input.name);
      if (fErr) return err(fErr);
      let container = node.data.fields;
      if (parent !== undefined) {
        const ph = findField(container, parent);
        if ("error" in ph) return err(ph.error);
        ph.field.children ??= [];
        container = ph.field.children;
      }
      const field = toField(input as FieldInput);
      container.push(field);
      // ฟิลด์ระดับบนที่ติดธง key/sessionkey/keygroup → pin ขึ้นต่อท้ายกลุ่ม key ด้านบน (PK/_id → key เก่า → ตัวใหม่)
      if (parent === undefined && (field.key || field.sessionkey || field.keygroup)) {
        pinKeyField(container, field);
      }
      await save(project, p);
      return ok({ id: field.id, name: field.name });
    })
  );

  server.registerTool(
    "update_field",
    {
      title: "แก้ฟิลด์",
      description:
        "แก้คุณสมบัติฟิลด์ (ส่งเฉพาะที่จะแก้) — หลังแก้ฟิลด์ต้องมีคำอธิบายภาษาไทยเสมอ (เรียก check_descriptions เพื่อเช็กจุดที่ยังขาดได้) · อ้าง field ด้วย id หรือ dotted path ของชื่อ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        field: z.string().describe("id หรือ dotted path เช่น \"address.geo.lat\""),
        name: z.string().min(1).max(200, LIMIT_NAME).optional(),
        type: z.enum(FIELD_TYPES).optional(),
        required: z.boolean().optional(),
        description: z.string().optional().describe("ต้องเป็นภาษาไทย (ลบคำอธิบายเดิมไม่ได้)"),
        of: z.enum(FIELD_TYPES).optional(),
        enum: z.array(z.string()).optional().describe("ส่ง [] เพื่อลบ enum"),
        default: z.string().optional().describe("ส่งสตริงว่างเพื่อลบค่าเริ่มต้น"),
        unique: z.boolean().optional(),
    bounded: z.boolean().optional().describe("array ของ object: ยืนยันว่ามีขอบเขตแล้ว (linter ไม่เตือนเพดาน 16MB)"),
        key: z.boolean().optional().describe("business key — field ที่ collection อื่นใช้อ้างอิง (แสดง 🔑)"),
        sessionkey: z.boolean().optional().describe("session/tenant scope key เช่น holdingcode (แสดง 🌐)"),
        keygroup: z.string().max(200, LIMIT_NAME).optional().describe("id กลุ่ม key ผสม (แสดง ⛓) — ส่งสตริงว่างเพื่อออกจากกลุ่ม"),
        keygroupunique: z.boolean().optional().describe("กลุ่ม key ผสมห้ามซ้ำ (default true) — false = compound index ธรรมดา ซ้ำได้"),
        children: z
          .array(fieldInputSchema)
          .max(300, LIMIT_FIELDS)
          .optional()
          .describe("แทนที่ฟิลด์ย่อยทั้งชุด (ต้องมีคำอธิบายไทยครบ — ซ้อนได้ 2 ชั้นต่อคำสั่ง)"),
      },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, diagram, collection, field: ref, children, ...patch }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      const fh = findField(node.data.fields, ref);
      if ("error" in fh) return err(fh.error);
      const f = fh.field;
      // หลังแก้ต้องเหลือคำอธิบายไทยเสมอ — ถ้ายังไม่มีให้ส่ง description ภาษาไทยมาด้วย
      const newDesc =
        patch.description !== undefined && patch.description !== ""
          ? patch.description
          : f.description;
      const dErr = thaiDescError(`field "${patch.name ?? f.name}"`, newDesc);
      if (dErr) return err(dErr);
      if (children !== undefined) {
        const cErr = fieldsThaiError(children) ?? fieldsDepthError(children, ref);
        if (cErr) return err(cErr);
      }
      // จำ "เป็น key อยู่ก่อนไหม" ไว้ก่อนแก้ — pin เฉพาะตอนเพิ่งกลายเป็น key (ห้ามเรียงกลุ่ม key เดิมใหม่)
      const wasKey = Boolean(f.key || f.sessionkey || f.keygroup);
      if (patch.name !== undefined) f.name = patch.name;
      if (patch.type !== undefined) f.type = patch.type;
      if (patch.required !== undefined) f.required = patch.required;
      f.description = newDesc;
      if (patch.of !== undefined) f.of = patch.of;
      if (patch.enum !== undefined) {
        if (patch.enum.length === 0) delete f.enum;
        else f.enum = patch.enum;
      }
      if (patch.default !== undefined) {
        if (patch.default === "") delete f.default;
        else f.default = patch.default;
      }
      if (patch.unique !== undefined) f.unique = patch.unique;
      if (patch.bounded !== undefined) f.bounded = patch.bounded;
      if (patch.key !== undefined) f.key = patch.key;
      if (patch.sessionkey !== undefined) f.sessionkey = patch.sessionkey;
      if (patch.keygroup !== undefined) {
        if (patch.keygroup === "") delete f.keygroup;
        else f.keygroup = patch.keygroup;
      }
      if (patch.keygroupunique !== undefined) f.keygroupunique = patch.keygroupunique;
      if (children !== undefined) f.children = children.map(toField);
      // ฟิลด์ระดับบนที่เพิ่งติดธง key/sessionkey/keygroup → pin ขึ้นต่อท้ายกลุ่ม key เหมือน add_field/UI
      if (
        !wasKey &&
        Boolean(f.key || f.sessionkey || f.keygroup) &&
        fh.container === node.data.fields
      ) {
        pinKeyField(fh.container, f);
      }
      await save(project, p);
      return ok({ id: f.id, name: f.name });
    })
  );

  server.registerTool(
    "delete_field",
    {
      title: "ลบฟิลด์",
      description: "ลบฟิลด์ (พร้อมเส้นอ้างอิงที่ผูกกับมัน) — อ้างด้วย id หรือ dotted path",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        field: z.string().describe("id หรือ dotted path เช่น \"address.geo.lat\""),
      },
      annotations: DESTRUCTIVE,
    },
    withRetry(async ({ project, diagram, collection, field: ref }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      const fh = findField(node.data.fields, ref);
      if ("error" in fh) return err(fh.error);
      fh.container.splice(fh.container.indexOf(fh.field), 1);
      // กวาดเส้นที่ผูกกับ field นี้ทั้งฝั่งต้นทาง (FK, -s) และฝั่งถูกอ้าง (business key, -t)
      // ในทุก diagram — เส้นข้าม tab เก็บใน diagram ต้นทาง (tab อื่น) แบบเดียวกับ delete_collection
      for (const dd of Object.values(p.diagrams)) {
        dd.edges = (dd.edges as E[]).filter(
          (e) =>
            !(e.source === node.id && e.sourceHandle === `${fh.field.id}-s`) &&
            !(e.target === node.id && e.targetHandle === `${fh.field.id}-t`)
        );
      }
      await save(project, p);
      return ok(`ลบ field "${fh.field.name}" แล้ว`);
    })
  );

  // ----- จัดการความสัมพันธ์ -----

  server.registerTool(
    "add_relation",
    {
      title: "สร้างเส้นความสัมพันธ์",
      description:
        "สร้างเส้นความสัมพันธ์แบบ field→field: ฟิลด์ต้นทาง (FK) → ฟิลด์เป้าหมายที่ถูกอ้าง (business key เช่น code — ห้ามอ้าง guidfixed) (1 ฟิลด์ = 1 อ้างอิง: ถ้ามีอยู่แล้วจะย้ายปลายทาง) — reference ทำให้ codegen ใส่ ref/index, embed = เส้นประ · เป้าหมายอยู่คนละ tab ได้ (relations ข้าม tab — เส้นเก็บใน diagram ต้นทาง)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam.describe("collection ต้นทาง"),
        field: z.string().describe("id หรือชื่อฟิลด์ต้นทาง (ระดับบน)"),
        target: z.string().describe("node id หรือ label ของ collection เป้าหมาย"),
        targetfield: z.string().describe("id หรือชื่อฟิลด์เป้าหมายที่ถูกอ้าง (business key เช่น code — relation เป็น field→field เสมอ ห้ามอ้าง guidfixed)"),
        kind: z.enum(["reference", "embed"]).optional().describe("default reference"),
        cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
      },
      annotations: WRITE,
    },
    withRetry(async ({ project, diagram, collection, field, target, targetfield, kind, cardinality }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      // เป้าหมาย: หาใน diagram ปัจจุบันก่อน ไม่เจอค่อยหาทุก diagram (relations ข้าม tab ได้)
      let targetNode = findNode(hit.d, target);
      let crossTab = false;
      if ("error" in targetNode) {
        for (const [did, dd] of Object.entries(p.diagrams)) {
          if (did === hit.id) continue;
          const tn = findNode(dd, target);
          if (!("error" in tn)) {
            targetNode = tn;
            crossTab = true;
            break;
          }
        }
      }
      if ("error" in targetNode) return err(targetNode.error);
      const fh = findField(node.data.fields, field);
      if ("error" in fh) return err(fh.error);
      const tf = findField(targetNode.data.fields, targetfield);
      if ("error" in tf) return err(tf.error);
      const relKind = kind ?? "reference";
      const embed = relKind === "embed";
      const edges = (hit.d.edges as E[]).filter(
        (e) => !(e.source === node.id && e.sourceHandle === `${fh.field.id}-s`)
      );
      const edge: E = {
        id: `e_${node.data.label}_${fh.field.name}_${targetNode.data.label}`,
        source: node.id,
        sourceHandle: `${fh.field.id}-s`,
        target: targetNode.id,
        targetHandle: `${tf.field.id}-t`,
        data: { kind: relKind, ...(cardinality !== undefined && { cardinality }) },
        // reference ปล่อยให้ defaultEdgeOptions ของ UI ใส่ animated/style เอง
        ...(embed && {
          animated: false,
          style: { stroke: "#64748b", strokeWidth: 1.5, strokeDasharray: "6 3" },
        }),
      };
      edges.push(edge);
      hit.d.edges = edges;
      await save(project, p);
      return ok({
        id: edge.id,
        from: `${node.data.label}.${fh.field.name}`,
        to: `${targetNode.data.label}.${tf.field.name}`,
        ...(crossTab && { crossTab: true, note: "เส้นข้าม tab — target อยู่คนละ diagram (เก็บใน diagram ต้นทาง)" }),
      });
    })
  );

  server.registerTool(
    "delete_relation",
    {
      title: "ลบเส้นความสัมพันธ์",
      description: "ลบเส้นความสัมพันธ์ — อ้างด้วย edge id หรือฟิลด์ต้นทาง",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        relation: z.string().optional().describe("edge id"),
        collection: collectionParam.optional(),
        field: z.string().optional().describe("id หรือชื่อฟิลด์ต้นทาง"),
      },
      annotations: DESTRUCTIVE,
    },
    withRetry(async ({ project, diagram, relation, collection, field }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      let edges = hit.d.edges as E[];
      const before = edges.length;
      if (relation !== undefined) {
        edges = edges.filter((e) => e.id !== relation);
      } else if (collection !== undefined && field !== undefined) {
        const node = findNode(hit.d, collection);
        if ("error" in node) return err(node.error);
        const fh = findField(node.data.fields, field);
        if ("error" in fh) return err(fh.error);
        edges = edges.filter(
          (e) => !(e.source === node.id && e.sourceHandle === `${fh.field.id}-s`)
        );
      } else {
        return err("[INVALID_ARGUMENT] ต้องส่ง relation (edge id) หรือ collection + field");
      }
      if (edges.length === before) return err("[RELATION_NOT_FOUND] ไม่พบเส้นความสัมพันธ์ที่ระบุ");
      hit.d.edges = edges;
      await save(project, p);
      return ok("ลบเส้นความสัมพันธ์แล้ว");
    })
  );

  // ----- bulk import -----

  server.registerTool(
    "replace_diagram",
    {
      title: "เขียนผังทับทั้งก้อน",
      description:
        "เขียน diagram ทับทั้งก้อนในครั้งเดียว (bulk import): collections พร้อม fields ซ้อน + relations — validate ทั้งหมดก่อนแล้วค่อยเขียน (atomic, rev +1 ครั้งเดียว) · description ไทยบังคับเหมือน add_collection · ใช้สร้าง diagram ใหม่ทั้งผังในคำสั่งเดียวแทนการเรียก add_* หลายรอบ · เส้นข้าม tab จาก diagram อื่นที่ชี้ node เดิมถูกกวาดทิ้ง (รายงานจำนวนใน response)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collections: z
          .array(
            z.object({
              label: z.string().min(1).max(200, LIMIT_NAME).describe("ชื่อ collection — ห้ามซ้ำใน payload"),
              description: z.string().min(1).describe("คำอธิบาย (บังคับ — ภาษาไทย)"),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              fields: z
                .array(fieldInputSchema)
                .max(300, LIMIT_FIELDS)
                .optional()
                .describe("ทุก field ต้องมี description ภาษาไทย (รวม children — ซ้อนได้ 2 ชั้นต่อคำสั่ง)"),
            })
          )
          .min(1)
          .max(200, LIMIT_COLLECTIONS),
        relations: z
          .array(
            z.object({
              collection: z.string().describe("label collection ต้นทาง"),
              field: z.string().describe("ชื่อฟิลด์ต้นทาง"),
              target: z.string().describe("label collection เป้าหมาย"),
              targetfield: z.string().describe("ชื่อฟิลด์เป้าหมายที่ถูกอ้าง (business key เช่น code — field→field เสมอ ห้ามอ้าง guidfixed)"),
              kind: z.enum(["reference", "embed"]).optional(),
              cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
            })
          )
          .max(500, LIMIT_RELATIONS)
          .optional(),
      },
      annotations: DESTRUCTIVE,
    },
    withRetry(async ({ project, diagram, collections, relations }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      // validate ทั้งหมดก่อน — ห้ามเขียนค้าง (all-or-nothing)
      const seen = new Set<string>();
      for (const c of collections) {
        if (seen.has(c.label)) return err(`[DUPLICATE_LABEL] label "${c.label}" ซ้ำใน payload`);
        seen.add(c.label);
        const dErr = thaiDescError(`collection "${c.label}"`, c.description);
        if (dErr) return err(dErr);
        if (c.fields) {
          const fErr = fieldsThaiError(c.fields) ?? fieldsDepthError(c.fields);
          if (fErr) return err(fErr);
        }
      }
      // สร้าง nodes (id ใหม่ทั้งหมด)
      const nodes: N[] = collections.map((c, i) => ({
        id: uid(),
        type: "collection",
        position: { x: c.x ?? 120 + i * 40, y: c.y ?? 120 + i * 40 },
        ...(c.width !== undefined && { width: c.width }),
        data: {
          label: c.label,
          description: c.description,
          fields:
            c.fields?.map(toField) ??
            [
              {
                id: uid(),
                name: "_id",
                type: "ObjectId" as const,
                required: true,
                description: "รหัส ObjectID ของเอกสาร",
              },
            ],
        },
      }));
      const nodeByLabel = new Map(nodes.map((n) => [n.data.label, n]));
      // สร้าง edges (อ้าง field ด้วยชื่อ → id ใหม่)
      const edges: E[] = [];
      for (const r of relations ?? []) {
        const src = nodeByLabel.get(r.collection);
        if (!src)
          return err(`[COLLECTION_NOT_FOUND] ไม่พบ collection ต้นทาง "${r.collection}" ใน payload`);
        const tgt = nodeByLabel.get(r.target);
        if (!tgt)
          return err(`[COLLECTION_NOT_FOUND] ไม่พบ collection เป้าหมาย "${r.target}" ใน payload`);
        const f = src.data.fields.find((x) => x.name === r.field);
        if (!f)
          return err(`[FIELD_NOT_FOUND] ไม่พบ field "${r.field}" ใน collection "${r.collection}"`);
        const tf = tgt.data.fields.find((x) => x.name === r.targetfield);
        if (!tf)
          return err(`[FIELD_NOT_FOUND] ไม่พบ field เป้าหมาย "${r.targetfield}" ใน collection "${r.target}"`);
        const embed = r.kind === "embed";
        edges.push({
          id: `e_${src.data.label}_${f.name}_${tgt.data.label}`,
          source: src.id,
          sourceHandle: `${f.id}-s`,
          target: tgt.id,
          targetHandle: `${tf.id}-t`,
          data: {
            kind: embed ? "embed" : "reference",
            ...(r.cardinality !== undefined && { cardinality: r.cardinality }),
          },
          ...(embed && {
            animated: false,
            style: { stroke: "#64748b", strokeWidth: 1.5, strokeDasharray: "6 3" },
          }),
        });
      }
      // node id เดิมหายหมด (สร้างใหม่ทั้งชุด) — กวาดเส้นข้าม tab ใน diagram อื่นที่ยังชี้ id เก่า
      // ไม่งั้น edge ค้างชี้ node ที่ไม่มีจริง = data corruption เงียบ (crossref/lint/codegen resolve ไม่เจอ)
      const oldIds = new Set((hit.d.nodes as N[]).map((n) => n.id));
      hit.d.nodes = nodes;
      hit.d.edges = edges;
      const crossTabEdgesRemoved = dropEdgesTouching(p, oldIds); // edges ใหม่ใช้ id ใหม่ ไม่โดนกวาด
      await save(project, p); // atomic — เขียนครั้งเดียว rev +1 ครั้งเดียว
      return ok({
        collections: nodes.length,
        fields: nodes.reduce((s, n) => s + n.data.fields.length, 0),
        relations: edges.length,
        // รายงานเสมอ ห้ามลบเงียบ — คนที่ re-import แล้วหวังให้เส้นข้าม tab อยู่ต่อจะได้รู้ว่าต้องสร้างใหม่
        crossTabEdgesRemoved,
      });
    })
  );

  // ----- สร้างโค้ด -----

  server.registerTool(
    "generate_code",
    {
      title: "สร้างโค้ดจากผัง",
      description:
        "สร้างโค้ดจาก diagram: mongosh (createCollection+validator+index), go (Go struct + bson tag), mongoose, typescript, markdown (data dictionary), sample (ตัวอย่าง JSON document), json (โครง diagram ดิบ), wiki (ชุดไฟล์ markdown โครงสร้าง wikillm: Home.md + collections/ + types/ — คืนเป็น JSON map ชื่อไฟล์→เนื้อหา) · ผลลัพธ์ใหญ่ได้ — จำกัดขนาดด้วย collection ทีละตัว",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        format: z.enum(["mongosh", "go", "mongoose", "typescript", "markdown", "sample", "json", "wiki"]),
        collection: collectionParam
          .optional()
          .describe("จำกัดเฉพาะ collection เดียว (ไม่ส่ง = ทั้ง diagram)"),
      },
      annotations: READ,
      _meta: { "anthropic/maxResultSizeChars": 200000 },
    },
    async ({ project, diagram, format, collection }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      let nodes = hit.d.nodes as N[];
      let edges = hit.d.edges as E[];
      if (collection !== undefined) {
        const node = findNode(hit.d, collection);
        if ("error" in node) return err(node.error);
        nodes = [node];
        edges = edges.filter((e) => e.source === node.id || e.target === node.id);
      }
      const gn = nodes.map(toGenNode);
      const ge = edges.map(toGenEdge);
      // node ทุก diagram — resolve ref ของเส้นข้าม tab ใน codegen
      const allGn = Object.values(p.diagrams).flatMap((d) => (d.nodes as N[]).map(toGenNode));
      if (format === "wiki") return ok(toWiki(gn, ge, project, allGn));
      const text =
        format === "mongosh"
          ? toMongosh(gn, ge, allGn)
          : format === "go"
            ? toGo(gn, ge)
            : format === "mongoose"
            ? toMongoose(gn, ge, allGn)
            : format === "typescript"
              ? toTypeScript(gn, ge)
              : format === "markdown"
                ? toMarkdown(gn, ge, allGn)
                : format === "sample"
                  ? gn.map((n) => `// ${n.data.label}\n` + toSampleDoc(n)).join("\n\n")
                  : JSON.stringify({ nodes, edges }, null, 2);
      return ok(text);
    }
  );

  return server;
}
