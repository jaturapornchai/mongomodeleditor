// app/mcp/server.ts — นิยาม MCP server ของ MongoModel + tools ทั้งหมด (แชร์ 2 transport)
// ใช้โดย app/mcp/route.ts (Streamable HTTP) และ mcp-stdio.ts (stdio สำหรับ client ที่ spawn process)
// ทุก tool ต้องระบุ project เสมอ (ทำได้หลาย project พร้อมกัน — ดูรายชื่อด้วย list_projects)
// ทุก mutation บันทึกลง data/projects.json ทันทีผ่าน store (auto save) และเพิ่ม rev ให้ UI auto refresh

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProject,
  saveProject,
  createProject,
  renameProject,
  deleteProject,
  listProjects,
  getWorkspace,
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

const save = (project: string, p: StoredProject) =>
  saveProject(project, { tabs: p.tabs, cur: p.cur, diagrams: p.diagrams });

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

type FieldInput = {
  name: string;
  type: FieldType;
  required?: boolean;
  description: string; // บังคับ — ต้องเป็นภาษาไทย (ตรวจด้วย fieldsThaiError)
  of?: FieldType;
  enum?: string[];
  default?: string;
  unique?: boolean;
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
// → นิยาม children ลึกจำกัด 4 ชั้นแบบ inline ไม่มี $ref (ลึกกว่านี้ค่อยเติมทีละชั้นด้วย add_field + parent)
// runtime (toField/fieldsThaiError) ยัง recurse ได้ไม่จำกัดตาม type FieldInput — จำกัดเฉพาะ schema ที่ validate input
const fieldShape = {
  name: z.string().min(1).describe("ชื่อฟิลด์"),
  type: z.enum(FIELD_TYPES).describe("ชนิดข้อมูล"),
  required: z.boolean().optional(),
  description: z.string().min(1).describe("คำอธิบายฟิลด์ (บังคับ — ต้องเป็นภาษาไทย)"),
  of: z.enum(FIELD_TYPES).optional().describe("ชนิดสมาชิก (เฉพาะ type=Array)"),
  enum: z.array(z.string()).optional().describe("ค่าที่อนุญาต"),
  default: z.string().optional().describe("ค่าเริ่มต้น (string เสมอ)"),
  unique: z.boolean().optional(),
};
const childrenDesc = "ฟิลด์ย่อย (type=Object หรือ Array<Object>)";
const fieldL4 = z.object(fieldShape);
const fieldL3 = z.object({ ...fieldShape, children: z.array(fieldL4).optional().describe(childrenDesc) });
const fieldL2 = z.object({ ...fieldShape, children: z.array(fieldL3).optional().describe(childrenDesc) });
const fieldL1 = z.object({ ...fieldShape, children: z.array(fieldL2).optional().describe(childrenDesc) });
const fieldInputSchema = z.object({
  ...fieldShape,
  children: z.array(fieldL1).optional().describe(childrenDesc),
});

// ---------- สร้าง server + ลงทะเบียน tools ----------

export function createServer(): McpServer {
  const server = new McpServer({ name: "mongomodel", version: "2.0.0" });

  // ----- จัดการ project -----

  server.registerTool(
    "list_projects",
    { description: "แสดงรายการ project ทั้งหมด (ชื่อ, จำนวน diagram/collection, เวลาแก้ล่าสุด)" },
    async () => ok(await listProjects())
  );

  server.registerTool(
    "create_project",
    {
      description: "สร้าง project ใหม่ (ว่าง มี Main Diagram ให้)",
      inputSchema: { name: z.string().min(1).describe("ชื่อ project — ห้ามซ้ำกับที่มีอยู่") },
    },
    async ({ name }) => {
      if (!validProjectName(name)) return err("ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)");
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
      description: "เปลี่ยนชื่อ project",
      inputSchema: { project: projectParam, name: z.string().min(1).describe("ชื่อใหม่") },
    },
    async ({ project, name }) => {
      if (!validProjectName(name)) return err("ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)");
      try {
        await renameProject(project, name.trim());
        return ok({ name: name.trim() });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    "delete_project",
    {
      description: "ลบ project ถาวร (ทุก diagram ในนั้นหายหมด)",
      inputSchema: { project: projectParam },
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
      description: "แสดงรายการ diagram ทั้งหมดใน project (id, ชื่อ, จำนวน collection, อันที่กำลังเปิด)",
      inputSchema: { project: projectParam },
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
      description:
        "อ่าน diagram เต็ม (nodes = collection พร้อม fields, edges = ความสัมพันธ์) เอาไปใช้ต่อได้",
      inputSchema: { project: projectParam, diagram: diagramParam },
    },
    async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      return ok({ id: hit.id, name: hit.name, nodes: hit.d.nodes, edges: hit.d.edges });
    }
  );

  server.registerTool(
    "check_descriptions",
    {
      description:
        "ตรวจว่า collection/field ไหนยังไม่มีคำอธิบายภาษาไทย — คืนรายการ path ที่ต้องไปเติม (ว่าง = ครบแล้ว) ใช้ก่อน generate_code เพื่อให้เอกสารออกมามีคำอธิบายไทยครบ",
      inputSchema: { project: projectParam, diagram: diagramParam },
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
      description: "สร้าง diagram ใหม่ (ว่าง) แล้วสลับไปที่มัน",
      inputSchema: { project: projectParam, name: z.string().min(1).describe("ชื่อ diagram") },
    },
    async ({ project, name }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const id = uid();
      p.tabs.push({ id, name });
      p.diagrams[id] = { nodes: [], edges: [] };
      p.cur = id;
      await save(project, p);
      return ok({ id, name });
    }
  );

  server.registerTool(
    "rename_diagram",
    {
      description: "เปลี่ยนชื่อ diagram",
      inputSchema: { project: projectParam, diagram: diagramParam, name: z.string().min(1) },
    },
    async ({ project, diagram, name }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const tab = p.tabs.find((t) => t.id === hit.id);
      if (tab) tab.name = name;
      await save(project, p);
      return ok({ id: hit.id, name });
    }
  );

  server.registerTool(
    "delete_diagram",
    {
      description: "ลบ diagram ถาวร (ถ้าเหลือ 0 จะสร้าง Main Diagram ว่างให้)",
      inputSchema: { project: projectParam, diagram: diagramParam },
    },
    async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      p.tabs = p.tabs.filter((t) => t.id !== hit.id);
      delete p.diagrams[hit.id];
      // เส้นข้าม tab จาก diagram อื่นที่ชี้เข้ามา diagram ที่ถูกลบ — เก็บกวาดด้วย
      const deletedIds = new Set((hit.d.nodes as N[]).map((n) => n.id));
      for (const dd of Object.values(p.diagrams)) {
        dd.edges = (dd.edges as E[]).filter(
          (e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)
        );
      }
      if (!p.tabs.length) {
        const id = uid();
        p.tabs = [{ id, name: "Main Diagram" }];
        p.diagrams[id] = { nodes: [], edges: [] };
      }
      if (p.cur === hit.id || !p.diagrams[p.cur]) p.cur = p.tabs[0].id;
      await save(project, p);
      return ok(`ลบ "${hit.name}" แล้ว`);
    }
  );

  server.registerTool(
    "switch_diagram",
    {
      description: "สลับ diagram ปัจจุบัน (อันที่ UI กำลังเปิด / default ของ tools อื่น)",
      inputSchema: { project: projectParam, diagram: diagramParam },
    },
    async ({ project, diagram }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      p.cur = hit.id;
      await save(project, p);
      return ok({ current: hit.id, name: hit.name });
    }
  );

  // ----- จัดการ collection -----

  server.registerTool(
    "add_collection",
    {
      description:
        "เพิ่ม collection ใหม่ — description บังคับต้องเป็นภาษาไทย (ทั้ง collection และทุก field ถ้าส่ง fields; เรียก check_descriptions เพื่อเช็กจุดที่ยังขาดได้) · ถ้าไม่ส่ง fields จะใส่ _id: ObjectId (PK) พร้อมคำอธิบายไทยให้อัตโนมัติ · label ซ้ำใน diagram เดียวกันถูกปฏิเสธ (เว้นแต่ replace: true)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        label: z.string().min(1).describe("ชื่อ collection — ห้ามซ้ำใน diagram เดียวกัน"),
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
          .optional()
          .describe("ฟิลด์เริ่มต้น — ทุก field ต้องมี description ภาษาไทย (รวม children)"),
      },
    },
    async ({ project, diagram, label, description, replace, x, y, fields }) => {
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
        const fErr = fieldsThaiError(fields);
        if (fErr) return err(fErr);
      }
      let position = { x: x ?? 0, y: y ?? 0 };
      if (dup) {
        // แทนที่: ลบ node เดิม + เส้นที่เกี่ยว คงตำแหน่งเดิมไว้
        position = { x: x ?? dup.position.x, y: y ?? dup.position.y };
        hit.d.nodes = (hit.d.nodes as N[]).filter((n) => n.id !== dup.id);
        hit.d.edges = (hit.d.edges as E[]).filter(
          (e) => e.source !== dup.id && e.target !== dup.id
        );
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
      return ok({ id: node.id, label, replaced: dup !== undefined });
    }
  );

  server.registerTool(
    "update_collection",
    {
      description: "แก้ชื่อ / คำอธิบาย collection — หลังแก้ collection ต้องมีคำอธิบายภาษาไทยเสมอ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        label: z.string().min(1).optional(),
        description: z.string().optional().describe("ต้องเป็นภาษาไทย (ลบคำอธิบายเดิมไม่ได้)"),
      },
    },
    async ({ project, diagram, collection, label, description }) => {
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
    }
  );

  server.registerTool(
    "delete_collection",
    {
      description: "ลบ collection พร้อมเส้นความสัมพันธ์ที่เกี่ยวข้องทั้งหมด (รวมเส้นข้าม tab ที่ชี้มาหามัน)",
      inputSchema: { project: projectParam, diagram: diagramParam, collection: collectionParam },
    },
    async ({ project, diagram, collection }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      hit.d.nodes = (hit.d.nodes as N[]).filter((n) => n.id !== node.id);
      // ลบเส้นที่เกี่ยวในทุก diagram (เส้นข้าม tab จาก tab อื่นชี้มาหาตัวนี้ด้วย)
      for (const dd of Object.values(p.diagrams)) {
        dd.edges = (dd.edges as E[]).filter(
          (e) => e.source !== node.id && e.target !== node.id
        );
      }
      await save(project, p);
      return ok(`ลบ collection "${node.data.label}" แล้ว`);
    }
  );

  server.registerTool(
    "move_collection",
    {
      description:
        "ย้าย collection ไป diagram อื่นในโปรเจกต์เดียวกัน — node id คงเดิม เส้นเดิมกลายเป็นข้าม tab อัตโนมัติ (ใช้แยกโซน master/transaction/types เป็นคนละ tab)",
      inputSchema: {
        project: projectParam,
        collection: collectionParam.describe("node id หรือ label ของ collection ที่จะย้าย (ค้นจากทุก diagram)"),
        to: z.string().describe("id หรือชื่อของ diagram ปลายทาง"),
      },
    },
    async ({ project, collection, to }) => {
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
    }
  );

  // ----- จัดการ field -----

  server.registerTool(
    "add_field",
    {
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
        name: z.string().min(1),
        type: z.enum(FIELD_TYPES),
        required: z.boolean().optional(),
        description: z.string().min(1).describe("คำอธิบายฟิลด์ (บังคับ — ต้องเป็นภาษาไทย)"),
        of: z.enum(FIELD_TYPES).optional(),
        enum: z.array(z.string()).optional(),
        default: z.string().optional(),
        unique: z.boolean().optional(),
        children: z.array(fieldInputSchema).optional(),
      },
    },
    async ({ project, diagram, collection, parent, ...input }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      // บังคับคำอธิบายไทย — ฟิลด์นี้และ children ทั้งหมด
      const fErr = fieldsThaiError([input as FieldInput]);
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
      await save(project, p);
      return ok({ id: field.id, name: field.name });
    }
  );

  server.registerTool(
    "update_field",
    {
      description:
        "แก้คุณสมบัติฟิลด์ (ส่งเฉพาะที่จะแก้) — หลังแก้ฟิลด์ต้องมีคำอธิบายภาษาไทยเสมอ (เรียก check_descriptions เพื่อเช็กจุดที่ยังขาดได้) · อ้าง field ด้วย id หรือ dotted path ของชื่อ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        field: z.string().describe("id หรือ dotted path เช่น \"address.geo.lat\""),
        name: z.string().min(1).optional(),
        type: z.enum(FIELD_TYPES).optional(),
        required: z.boolean().optional(),
        description: z.string().optional().describe("ต้องเป็นภาษาไทย (ลบคำอธิบายเดิมไม่ได้)"),
        of: z.enum(FIELD_TYPES).optional(),
        enum: z.array(z.string()).optional().describe("ส่ง [] เพื่อลบ enum"),
        default: z.string().optional().describe("ส่งสตริงว่างเพื่อลบค่าเริ่มต้น"),
        unique: z.boolean().optional(),
        children: z.array(fieldInputSchema).optional().describe("แทนที่ฟิลด์ย่อยทั้งชุด (ต้องมีคำอธิบายไทยครบ)"),
      },
    },
    async ({ project, diagram, collection, field: ref, children, ...patch }) => {
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
        const cErr = fieldsThaiError(children);
        if (cErr) return err(cErr);
      }
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
      if (children !== undefined) f.children = children.map(toField);
      await save(project, p);
      return ok({ id: f.id, name: f.name });
    }
  );

  server.registerTool(
    "delete_field",
    {
      description: "ลบฟิลด์ (พร้อมเส้นอ้างอิงที่ผูกกับมัน) — อ้างด้วย id หรือ dotted path",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        field: z.string().describe("id หรือ dotted path เช่น \"address.geo.lat\""),
      },
    },
    async ({ project, diagram, collection, field: ref }) => {
      const p = await requireProject(project);
      if ("error" in p) return err(p.error);
      const hit = findDiagram(p, diagram);
      if ("error" in hit) return err(hit.error);
      const node = findNode(hit.d, collection);
      if ("error" in node) return err(node.error);
      const fh = findField(node.data.fields, ref);
      if ("error" in fh) return err(fh.error);
      fh.container.splice(fh.container.indexOf(fh.field), 1);
      hit.d.edges = (hit.d.edges as E[]).filter(
        (e) => !(e.source === node.id && e.sourceHandle === `${fh.field.id}-s`)
      );
      await save(project, p);
      return ok(`ลบ field "${fh.field.name}" แล้ว`);
    }
  );

  // ----- จัดการความสัมพันธ์ -----

  server.registerTool(
    "add_relation",
    {
      description:
        "สร้างเส้นความสัมพันธ์จากฟิลด์ต้นทาง → collection เป้าหมาย (1 ฟิลด์ = 1 อ้างอิง: ถ้ามีอยู่แล้วจะย้ายปลายทาง) — reference ทำให้ codegen ใส่ ref/index, embed = เส้นประ · เป้าหมายอยู่คนละ tab ได้ (relations ข้าม tab — เส้นเก็บใน diagram ต้นทาง)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam.describe("collection ต้นทาง"),
        field: z.string().describe("id หรือชื่อฟิลด์ต้นทาง (ระดับบน)"),
        target: z.string().describe("node id หรือ label ของ collection เป้าหมาย"),
        kind: z.enum(["reference", "embed"]).optional().describe("default reference"),
        cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
      },
    },
    async ({ project, diagram, collection, field, target, kind, cardinality }) => {
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
        targetHandle: "ref",
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
        to: targetNode.data.label,
        ...(crossTab && { crossTab: true, note: "เส้นข้าม tab — target อยู่คนละ diagram (เก็บใน diagram ต้นทาง)" }),
      });
    }
  );

  server.registerTool(
    "delete_relation",
    {
      description: "ลบเส้นความสัมพันธ์ — อ้างด้วย edge id หรือฟิลด์ต้นทาง",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        relation: z.string().optional().describe("edge id"),
        collection: collectionParam.optional(),
        field: z.string().optional().describe("id หรือชื่อฟิลด์ต้นทาง"),
      },
    },
    async ({ project, diagram, relation, collection, field }) => {
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
        return err("ต้องส่ง relation (edge id) หรือ collection + field");
      }
      if (edges.length === before) return err("ไม่พบเส้นความสัมพันธ์ที่ระบุ");
      hit.d.edges = edges;
      await save(project, p);
      return ok("ลบเส้นความสัมพันธ์แล้ว");
    }
  );

  // ----- bulk import -----

  server.registerTool(
    "replace_diagram",
    {
      description:
        "เขียน diagram ทับทั้งก้อนในครั้งเดียว (bulk import): collections พร้อม fields ซ้อน + relations — validate ทั้งหมดก่อนแล้วค่อยเขียน (atomic, rev +1 ครั้งเดียว) · description ไทยบังคับเหมือน add_collection · ใช้สร้าง diagram ใหม่ทั้งผังในคำสั่งเดียวแทนการเรียก add_* หลายรอบ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collections: z
          .array(
            z.object({
              label: z.string().min(1).describe("ชื่อ collection — ห้ามซ้ำใน payload"),
              description: z.string().min(1).describe("คำอธิบาย (บังคับ — ภาษาไทย)"),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().optional(),
              fields: z
                .array(fieldInputSchema)
                .optional()
                .describe("ทุก field ต้องมี description ภาษาไทย (รวม children)"),
            })
          )
          .min(1),
        relations: z
          .array(
            z.object({
              collection: z.string().describe("label collection ต้นทาง"),
              field: z.string().describe("ชื่อฟิลด์ต้นทาง"),
              target: z.string().describe("label collection เป้าหมาย"),
              kind: z.enum(["reference", "embed"]).optional(),
              cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
            })
          )
          .optional(),
      },
    },
    async ({ project, diagram, collections, relations }) => {
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
          const fErr = fieldsThaiError(c.fields);
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
        const embed = r.kind === "embed";
        edges.push({
          id: `e_${src.data.label}_${f.name}_${tgt.data.label}`,
          source: src.id,
          sourceHandle: `${f.id}-s`,
          target: tgt.id,
          targetHandle: "ref",
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
      hit.d.nodes = nodes;
      hit.d.edges = edges;
      await save(project, p); // atomic — เขียนครั้งเดียว rev +1 ครั้งเดียว
      return ok({
        collections: nodes.length,
        fields: nodes.reduce((s, n) => s + n.data.fields.length, 0),
        relations: edges.length,
      });
    }
  );

  // ----- สร้างโค้ด -----

  server.registerTool(
    "generate_code",
    {
      description:
        "สร้างโค้ดจาก diagram: mongosh (createCollection+validator+index), mongoose, typescript, markdown (data dictionary), sample (ตัวอย่าง JSON document), json (โครง diagram ดิบ), wiki (ชุดไฟล์ markdown โครงสร้าง wikillm: Home.md + collections/ + types/ — คืนเป็น JSON map ชื่อไฟล์→เนื้อหา)",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        format: z.enum(["mongosh", "mongoose", "typescript", "markdown", "sample", "json", "wiki"]),
        collection: collectionParam
          .optional()
          .describe("จำกัดเฉพาะ collection เดียว (ไม่ส่ง = ทั้ง diagram)"),
      },
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
