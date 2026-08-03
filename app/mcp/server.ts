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
  type CollectionIndex,
  type IndexDirection,
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
  lintProject,
  fieldPathEntries,
  keyGroupsOf,
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
  if (!isThai(desc)) {
    // ค่าที่เป็น "?" ล้วน = ข้อความไทยถูก encode ผิดระหว่างส่ง (terminal/client ไม่ใช่ UTF-8)
    // ไม่ใช่ AI ลืมใส่ภาษาไทย — ต้องบอกใบ้ ไม่งั้นฝั่งโน้น debug ผิดทาง (ไปแก้ prompt แทน transport)
    const hint = /^[?\s]+$/.test(desc) && desc.includes("?")
      ? ' (ค่าที่ได้รับเป็น "?" ล้วน — ข้อความไทยน่าจะถูกแปลงเพี้ยนระหว่างส่ง ตรวจว่า client ส่ง UTF-8 หรือไม่)'
      : "";
    return `[DESCRIPTION_NOT_THAI] ${what} description ต้องเป็นภาษาไทย (อย่างน้อยมีอักขระไทย) — ได้รับ: "${desc}"${hint}`;
  }
  return null;
}

/** กฎห้ามอ้าง guidfixed (AGENTS.md): identity ภายในเครื่อง ไม่พกพาตอน export/import — relation ต้องชี้ business key */
function guidfixedTargetError(targetLabel: string, targetFieldName: string): string | null {
  if (targetFieldName.toLowerCase() !== "guidfixed") return null;
  return `[RELATION_TARGET_GUIDFIXED] ห้ามสร้าง relation ชี้ไปที่ "${targetLabel}.${targetFieldName}" — guidfixed เป็น identity ภายในเครื่อง ไม่ถูกพกพาตอน export/import (ความสัมพันธ์จะพังหลังย้ายข้อมูล) ให้ชี้ business key ของฝั่งแม่แทน เช่น code/holdingcode`;
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
  const findById = (container: Field[]): { container: Field[]; field: Field } | undefined => {
    for (const field of container) {
      if (field.id === ref) return { container, field };
      const nested = field.children && findById(field.children);
      if (nested) return nested;
    }
  };
  const byId = findById(fields);
  if (byId) return byId;
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

type IndexInput = {
  fields: { field: string; direction?: IndexDirection }[];
  unique?: boolean;
  sparse?: boolean;
};

/** รับ field id หรือ dotted path จาก MCP แล้วเก็บเป็น id; validate ทั้งก้อนก่อนเขียน */
function toIndexes(
  fields: Field[],
  inputs: IndexInput[],
  existing: CollectionIndex[] = [],
  referenceFields: Iterable<string> = [],
): CollectionIndex[] | { error: string } {
  if (inputs.length > 63) return { error: LIMIT_INDEXES.error };
  const indexes: CollectionIndex[] = [];
  const seen = new Set<string>();
  const entries = fieldPathEntries(fields);
  const arrayOwner = new Map<string, string>();
  const walkArrayOwners = (nested: Field[], inherited?: string): void => {
    for (const field of nested) {
      const owner = field.type === "Array" ? field.id : inherited;
      if (owner) arrayOwner.set(field.id, owner);
      if ((field.type === "Object" || (field.type === "Array" && field.of === "Object")) && field.children?.length) {
        walkArrayOwners(field.children, owner);
      }
    }
  };
  walkArrayOwners(fields);
  const byId = new Map<string, typeof entries>();
  const byPath = new Map<string, typeof entries>();
  for (const entry of entries) {
    const ids = byId.get(entry.field.id) ?? [];
    ids.push(entry);
    byId.set(entry.field.id, ids);
    const paths = byPath.get(entry.path) ?? [];
    paths.push(entry);
    byPath.set(entry.path, paths);
  }
  const oldId = new Map(
    existing.map((index) => [
      JSON.stringify(index.fields.map((part) => [part.field, part.direction])),
      index.id,
    ]),
  );
  for (const input of inputs) {
    if (!input.fields.length) return { error: "[INDEX_EMPTY] index ต้องมีอย่างน้อย 1 field" };
    if (input.fields.length > 32) return { error: LIMIT_INDEX_FIELDS.error };
    const parts: CollectionIndex["fields"] = [];
    const members = new Set<string>();
    const paths = new Set<string>();
    const arrayMembers = new Set<string>();
    for (const part of input.fields) {
      const matches = byId.get(part.field) ?? byPath.get(part.field) ?? [];
      if (!matches.length) return { error: `[INDEX_FIELD_NOT_FOUND] ไม่พบ field "${part.field}"` };
      if (matches.length > 1) return { error: `[INDEX_FIELD_AMBIGUOUS] field "${part.field}" ซ้ำหรืออ้างได้หลายตำแหน่ง — ใช้ field id ที่ไม่ซ้ำ` };
      const hit = matches[0];
      if (members.has(hit.field.id)) {
        return { error: `[DUPLICATE_INDEX_FIELD] field "${part.field}" ซ้ำใน index เดียวกัน` };
      }
      if (paths.has(hit.path)) {
        return { error: `[DUPLICATE_INDEX_PATH] dotted path "${hit.path}" ซ้ำใน index เดียวกัน` };
      }
      const direction = part.direction ?? 1;
      if (direction !== 1 && direction !== -1) {
        return { error: "[INDEX_DIRECTION_INVALID] direction ต้องเป็น 1 หรือ -1" };
      }
      members.add(hit.field.id);
      paths.add(hit.path);
      const owner = arrayOwner.get(hit.field.id);
      if (owner) arrayMembers.add(owner);
      parts.push({ field: hit.field.id, direction });
    }
    if (arrayMembers.size > 1) {
      return { error: "[COMPOUND_INDEX_PARALLEL_ARRAYS] compound index แตะ array มากกว่า 1 สาย ซึ่ง MongoDB ไม่รองรับ" };
    }
    const signature = JSON.stringify(parts.map((part) => [part.field, part.direction]));
    if (seen.has(signature)) return { error: "[DUPLICATE_INDEX] มี index รูปแบบเดียวกันซ้ำใน collection" };
    seen.add(signature);
    indexes.push({
      id: oldId.get(signature) ?? uid(),
      fields: parts,
      ...(input.unique && { unique: true }),
      ...(input.sparse && { sparse: true }),
    });
  }
  const generated = new Set<string>();
  const prefixes = new Set<string>();
  for (const entry of entries) {
    if (entry.field.unique) {
      generated.add(JSON.stringify([[entry.path, 1]]));
      prefixes.add(entry.path);
    }
  }
  for (const group of keyGroupsOf(fields)) {
    if (group.fields.length < 2) continue;
    if (group.fields.length > 32) return { error: LIMIT_INDEX_FIELDS.error };
    if (group.fields.filter((field) => field.type === "Array").length > 1) {
      return { error: "[COMPOUND_INDEX_PARALLEL_ARRAYS] key ผสมแตะ array มากกว่า 1 สาย ซึ่ง MongoDB ไม่รองรับ" };
    }
    generated.add(JSON.stringify(group.fields.map((field) => [field.name, 1])));
    prefixes.add(group.fields[0].name);
  }
  for (const index of indexes) {
    const pattern = index.fields.map((part) => [byId.get(part.field)?.[0]?.path, part.direction]);
    generated.add(JSON.stringify(pattern));
    if (pattern[0]?.[0]) prefixes.add(String(pattern[0][0]));
  }
  for (const fieldId of referenceFields) {
    const entry = byId.get(fieldId)?.[0];
    if (!entry || entry.field.unique || prefixes.has(entry.path)) continue;
    generated.add(JSON.stringify([[entry.path, 1]]));
    prefixes.add(entry.path);
  }
  generated.delete(JSON.stringify([["_id", 1]]));
  const totalIndexes = generated.size + 1;
  if (totalIndexes > 64) {
    return { error: `[TOO_MANY_INDEXES] index รวม ${totalIndexes} ชุด (รวม _id และ index อัตโนมัติ) — MongoDB จำกัดไม่เกิน 64 ชุดต่อ collection` };
  }
  return indexes;
}

function fieldIds(field: Field): Set<string> {
  return new Set([field.id, ...(field.children ?? []).flatMap((child) => [...fieldIds(child)])]);
}

function referenceFieldIds(p: StoredProject, nodeId: string): Set<string> {
  const ids = new Set<string>();
  for (const diagram of Object.values(p.diagrams)) {
    for (const edge of diagram.edges as E[]) {
      if (edge.source !== nodeId || edge.data?.kind === "embed") continue;
      const id = edge.sourceHandle?.replace(/-s(-[lr])?$/, "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** กัน mutation อื่นเพิ่ม unique/keygroup/relation จนชนเพดาน MongoDB หลังสร้าง collection แล้ว */
function nodeIndexError(p: StoredProject, node: N): string | null {
  const inputs: IndexInput[] = (node.data.indexes ?? []).map((index) => ({
    fields: index.fields,
    ...(index.unique && { unique: true }),
    ...(index.sparse && { sparse: true }),
  }));
  const result = toIndexes(
    node.data.fields,
    inputs,
    node.data.indexes,
    referenceFieldIds(p, node.id),
  );
  return "error" in result ? result.error : null;
}

/** ลบทั้ง index เมื่อสมาชิกใดหาย — ห้ามย่อ compound index แล้วเปลี่ยน semantics เงียบ */
function dropIndexesTouching(node: N, ids: Set<string>): number {
  const before = node.data.indexes?.length ?? 0;
  node.data.indexes = (node.data.indexes ?? []).filter(
    (index) => !index.fields.some((part) => ids.has(part.field)),
  );
  if (!node.data.indexes.length) delete node.data.indexes;
  return before - (node.data.indexes?.length ?? 0);
}

function dropEdgesTouchingFields(p: StoredProject, nodeId: string, ids: Set<string>): number {
  let removed = 0;
  for (const diagram of Object.values(p.diagrams)) {
    const before = (diagram.edges as E[]).length;
    diagram.edges = (diagram.edges as E[]).filter(
      (edge) =>
        !(edge.source === nodeId && ids.has((edge.sourceHandle ?? "").replace(/-s(-[lr])?$/, ""))) &&
        !(edge.target === nodeId && ids.has((edge.targetHandle ?? "").replace(/-t(-[lr])?$/, ""))),
    );
    removed += before - (diagram.edges as E[]).length;
  }
  return removed;
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
  const isKey = (x: Field) => Boolean(x.key || x.keygroup || x.name === "_id");
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
const LIMIT_INDEXES = { error: "[TOO_MANY_INDEXES] indexes ที่กำหนดเพิ่มเกิน 63 รายการ — MongoDB จำกัดรวม _id และ index อัตโนมัติไม่เกิน 64 รายการต่อ collection" };
const LIMIT_INDEX_FIELDS = { error: "[TOO_MANY_INDEX_FIELDS] compound index เกิน 32 ฟิลด์ — ลดจำนวนสมาชิกตามเพดาน MongoDB" };

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
const indexInputSchema = z.object({
  fields: z
    .array(
      z.object({
        field: z.string().min(1, { error: "[INDEX_FIELD_EMPTY] ต้องระบุ field id หรือ dotted path" }).max(200, LIMIT_NAME).describe("field id หรือ dotted path เช่น address.city"),
        direction: z.union([z.literal(1), z.literal(-1)], { error: "[INDEX_DIRECTION_INVALID] direction ต้องเป็น 1 หรือ -1" }).optional().describe("1 = น้อยไปมาก, -1 = มากไปน้อย (default 1)"),
      }),
    )
    .min(1, { error: "[INDEX_EMPTY] index ต้องมีอย่างน้อย 1 field" })
    .max(32, LIMIT_INDEX_FIELDS),
  unique: z.boolean().optional().describe("true = ห้ามค่าซ้ำทั้งชุด"),
  sparse: z.boolean().optional().describe("true = ไม่ index เอกสารที่ไม่มีสมาชิกเลย; compound index จะเข้าเมื่อมีอย่างน้อย 1 field"),
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
5. indexes เพิ่มระดับ collection รับ field id หรือ dotted path; แก้ทั้งชุดด้วย update_collection.indexes ([] = ล้าง)
6. สร้างผังใหม่ทั้งก้อนใช้ replace_diagram (ระวัง: เขียนทับทั้ง diagram); แก้ทีละจุดใช้ add_*/update_*/delete_*
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
        collections: (hit.d.nodes as N[]).map((n) => {
          const pathById = new Map(fieldPathEntries(n.data.fields).map(({ path, field }) => [field.id, path]));
          return {
            id: n.id,
            label: n.data.label,
            description: n.data.description,
            fields: n.data.fields.map(summarizeField),
            ...((n.data.indexes?.length ?? 0) > 0 && {
              indexes: n.data.indexes?.map((index) => ({
                fields: index.fields.map((part) => ({
                  field: pathById.get(part.field) ?? part.field,
                  direction: part.direction,
                })),
                ...(index.unique && { unique: true }),
                ...(index.sparse && { sparse: true }),
              })),
            }),
          };
        }),
        relations,
      });
    }
  );

  server.registerTool(
    "lint_model",
    {
      title: "ตรวจโมเดล",
      description:
        "ตรวจโมเดลด้วยกฎที่เครื่องจับได้: ฟิลด์เงินที่ยังเป็น Number, index ผิด/ซ้ำ, unique บนฟิลด์ที่ไม่ required, สมาชิก key ผสมห้ามซ้ำที่ไม่ required, FK ที่ชนิดไม่ตรงกับปลายทาง, array ที่ไม่รู้ shape/ไม่มีขอบเขต และ shape ของ array *names — ไม่ระบุ diagram = ตรวจทั้ง project",
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
      let selectedId: string | undefined;
      if (diagram !== undefined) {
        const hit = findDiagram(p, diagram);
        if ("error" in hit) return err(hit.error); // มี [DIAGRAM_NOT_FOUND] + รายชื่อที่มีอยู่แล้ว
        selectedId = hit.id;
      }
      const diagrams = Object.entries(p.diagrams).map(([id, d]) => ({
        id,
        name: p.tabs.find((tab) => tab.id === id)?.name ?? id,
        nodes: (d.nodes ?? []) as unknown as GenNode[],
        edges: (d.edges ?? []) as unknown as GenEdge[],
      }));
      let issues = lintProject(diagrams);
      if (selectedId !== undefined) issues = issues.filter((issue) => issue.diagramId === selectedId);
      if (level === "error") issues = issues.filter((issue) => issue.level === "error");
      const out = diagrams.flatMap((d) => {
        const found = issues.filter((issue) => issue.diagramId === d.id);
        return found.length ? [{ diagram: d.name, issues: found }] : [];
      });
      const total = issues.length;
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
        indexes: z
          .array(indexInputSchema)
          .max(63, LIMIT_INDEXES)
          .optional()
          .describe("indexes ที่กำหนดเพิ่ม — field รับ id หรือ dotted path; ลำดับสมาชิกคือลำดับ compound index"),
      },
      annotations: DESTRUCTIVE, // replace: true ลบของเก่าพร้อมเส้นที่เกี่ยว
    },
    withRetry(async ({ project, diagram, label, description, replace, x, y, fields, indexes }) => {
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
      const nodeFields: Field[] =
        fields?.map(toField) ??
        [
          {
            id: uid(),
            name: "_id",
            type: "ObjectId",
            required: true,
            description: "รหัส ObjectID ของเอกสาร",
          },
        ];
      const nodeIndexes = toIndexes(nodeFields, indexes ?? []);
      if ("error" in nodeIndexes) return err(nodeIndexes.error);
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
          fields: nodeFields,
          ...(nodeIndexes.length && { indexes: nodeIndexes }),
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
      description: "แก้ชื่อ / คำอธิบาย / indexes ของ collection — ส่ง indexes:[] เพื่อล้าง; หลังแก้ collection ต้องมีคำอธิบายภาษาไทยเสมอ",
      inputSchema: {
        project: projectParam,
        diagram: diagramParam,
        collection: collectionParam,
        label: z.string().min(1).max(200, LIMIT_NAME).optional(),
        description: z.string().optional().describe("ต้องเป็นภาษาไทย (ลบคำอธิบายเดิมไม่ได้)"),
        indexes: z
          .array(indexInputSchema)
          .max(63, LIMIT_INDEXES)
          .optional()
          .describe("แทนที่ indexes ที่กำหนดเพิ่มทั้งชุด; field รับ id หรือ dotted path; [] = ล้างทั้งหมด"),
      },
      annotations: WRITE_IDEM,
    },
    withRetry(async ({ project, diagram, collection, label, description, indexes }) => {
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
      const nextIndexes = indexes === undefined
        ? undefined
        : toIndexes(node.data.fields, indexes, node.data.indexes, referenceFieldIds(p, node.id));
      if (nextIndexes && "error" in nextIndexes) return err(nextIndexes.error);
      node.data.label = newLabel;
      node.data.description = newDesc;
      if (nextIndexes !== undefined) {
        if (nextIndexes.length) node.data.indexes = nextIndexes;
        else delete node.data.indexes;
      }
      await save(project, p);
      return ok({ id: node.id, label: node.data.label, indexes: node.data.indexes?.length ?? 0 });
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
      // invariant: เส้นข้าม tab เก็บใน diagram ต้นทาง (source) เสมอ — node ที่เป็นฝั่ง source ย้ายไปไหน
      // เส้นต้องย้ายตาม ไม่งั้นเส้นค้างใน diagram ที่ไม่มี source → UI/get_diagram มองไม่เห็นเลย (orphan เงียบ)
      let edgesRehomed = 0;
      for (const dd of Object.values(p.diagrams)) {
        if (dd === dest.d) continue;
        const moving = (dd.edges as E[]).filter((e) => e.source === node.id);
        if (moving.length) {
          dd.edges = (dd.edges as E[]).filter((e) => e.source !== node.id);
          (dest.d.edges as E[]).push(...moving);
          edgesRehomed += moving.length;
        }
      }
      await save(project, p);
      return ok({
        moved: node.data.label,
        from: p.tabs.find((t) => t.id === fromId)?.name ?? fromId,
        to: dest.name,
        edgesRehomed,
        note: "เส้นความสัมพันธ์เดิมยังอยู่ — กลายเป็นเส้นข้าม tab โดยอัตโนมัติ (เส้นที่ collection นี้เป็นต้นทางถูกย้ายตามไป diagram ปลายทาง)",
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
      // ฟิลด์ระดับบนที่ติดธง key/keygroup → pin ขึ้นต่อท้ายกลุ่ม key ด้านบน (PK/_id → key เก่า → ตัวใหม่)
      if (parent === undefined && (field.key || field.keygroup)) {
        pinKeyField(container, field);
      }
      const indexErr = nodeIndexError(p, node);
      if (indexErr) return err(indexErr);
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
      const nextType = patch.type ?? f.type;
      const nextOf = nextType === "Array"
        ? patch.of ?? (f.type === "Array" ? f.of : undefined)
        : undefined;
      const canKeepChildren = nextType === "Object" || (nextType === "Array" && nextOf === "Object");
      if (children !== undefined && !canKeepChildren) {
        return err("[FIELD_CHILDREN_TYPE_INVALID] children ใช้ได้เฉพาะ Object หรือ Array<Object>");
      }
      // จำ "เป็น key อยู่ก่อนไหม" ไว้ก่อนแก้ — pin เฉพาะตอนเพิ่งกลายเป็น key (ห้ามเรียงกลุ่ม key เดิมใหม่)
      const wasKey = Boolean(f.key || f.keygroup);
      const replacingChildren = children !== undefined || !canKeepChildren;
      const replacedChildIds = !replacingChildren
        ? new Set<string>()
        : new Set((f.children ?? []).flatMap((child) => [...fieldIds(child)]));
      if (patch.name !== undefined) f.name = patch.name;
      if (patch.type !== undefined) f.type = patch.type;
      if (patch.required !== undefined) f.required = patch.required;
      f.description = newDesc;
      if (nextType !== "Array") delete f.of;
      else if (patch.of !== undefined) f.of = patch.of;
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
      if (patch.keygroup !== undefined) {
        if (patch.keygroup === "") delete f.keygroup;
        else f.keygroup = patch.keygroup;
      }
      if (patch.keygroupunique !== undefined) f.keygroupunique = patch.keygroupunique;
      if (children !== undefined) f.children = children.map(toField);
      else if (!canKeepChildren) {
        delete f.children;
        delete f.collapsed;
      }
      const indexesRemoved = replacedChildIds.size ? dropIndexesTouching(node, replacedChildIds) : 0;
      const edgesRemoved = replacedChildIds.size ? dropEdgesTouchingFields(p, node.id, replacedChildIds) : 0;
      // ฟิลด์ระดับบนที่เพิ่งติดธง key/keygroup → pin ขึ้นต่อท้ายกลุ่ม key เหมือน add_field/UI
      if (
        !wasKey &&
        Boolean(f.key || f.keygroup) &&
        fh.container === node.data.fields
      ) {
        pinKeyField(fh.container, f);
      }
      const indexErr = nodeIndexError(p, node);
      if (indexErr) return err(indexErr);
      await save(project, p);
      return ok({ id: f.id, name: f.name, indexesRemoved, edgesRemoved });
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
      const removedIds = fieldIds(fh.field);
      fh.container.splice(fh.container.indexOf(fh.field), 1);
      const indexesRemoved = dropIndexesTouching(node, removedIds);
      // กวาดเส้นทั้งฝั่งต้นทาง/ปลายทางในทุก diagram (รวมเส้นข้าม tab)
      const edgesRemoved = dropEdgesTouchingFields(p, node.id, removedIds);
      await save(project, p);
      return ok({ message: `ลบ field "${fh.field.name}" แล้ว`, indexesRemoved, edgesRemoved });
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
        field: z.string().describe("id หรือ dotted path ของฟิลด์ต้นทาง เช่น address.holdingcode"),
        target: z.string().describe("node id หรือ label ของ collection เป้าหมาย"),
        targetfield: z.string().describe("id หรือ dotted path ของฟิลด์เป้าหมายที่ถูกอ้าง (business key เช่น code — relation เป็น field→field เสมอ ห้ามอ้าง guidfixed)"),
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
      // บังคับกฎ "ห้ามอ้าง guidfixed" จริง (ไม่ใช่แค่เขียนไว้ใน description ของ tool)
      const gErr = guidfixedTargetError(targetNode.data.label, tf.field.name);
      if (gErr) return err(gErr);
      const relKind = kind ?? "reference";
      const embed = relKind === "embed";
      const edges = (hit.d.edges as E[]).filter(
        (e) => !(e.source === node.id && e.sourceHandle === `${fh.field.id}-s`)
      );
      const edge: E = {
        id: `e_${node.id}_${fh.field.id}_${targetNode.id}_${tf.field.id}`,
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
      const indexErr = nodeIndexError(p, node);
      if (indexErr) return err(indexErr);
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
              indexes: z
                .array(indexInputSchema)
                .max(63, LIMIT_INDEXES)
                .optional()
                .describe("indexes ที่กำหนดเพิ่ม — field รับ id หรือ dotted path"),
            })
          )
          .min(1)
          .max(200, LIMIT_COLLECTIONS),
        relations: z
          .array(
            z.object({
              collection: z.string().describe("label collection ต้นทาง"),
              field: z.string().describe("dotted path ของฟิลด์ต้นทาง"),
              target: z.string().describe("label collection เป้าหมาย"),
              targetfield: z.string().describe("dotted path ของฟิลด์เป้าหมายที่ถูกอ้าง (business key เช่น code — field→field เสมอ ห้ามอ้าง guidfixed)"),
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
      // สร้าง nodes (id ใหม่ทั้งหมด) + resolve index path เป็น field id ก่อนแตะ diagram เดิม
      const nodes: N[] = [];
      for (const [i, c] of collections.entries()) {
        const nodeFields: Field[] =
          c.fields?.map(toField) ??
          [
            {
              id: uid(),
              name: "_id",
              type: "ObjectId" as const,
              required: true,
              description: "รหัส ObjectID ของเอกสาร",
            },
          ];
        const indexes = toIndexes(nodeFields, c.indexes ?? []);
        if ("error" in indexes) return err(`[INVALID_INDEX] collection "${c.label}": ${indexes.error}`);
        nodes.push({
          id: uid(),
          type: "collection",
          position: { x: c.x ?? 120 + i * 40, y: c.y ?? 120 + i * 40 },
          ...(c.width !== undefined && { width: c.width }),
          data: {
            label: c.label,
            description: c.description,
            fields: nodeFields,
            ...(indexes.length && { indexes }),
          },
        });
      }
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
        const fh = findField(src.data.fields, r.field);
        if ("error" in fh) return err(`${fh.error} ใน collection "${r.collection}"`);
        const tfh = findField(tgt.data.fields, r.targetfield);
        if ("error" in tfh) return err(`${tfh.error} ใน collection "${r.target}"`);
        const f = fh.field;
        const tf = tfh.field;
        // กฎเดียวกับ add_relation — validate ก่อนเขียน (all-or-nothing)
        const gErr = guidfixedTargetError(r.target, tf.name);
        if (gErr) return err(gErr);
        const embed = r.kind === "embed";
        edges.push({
          id: `e_${src.id}_${f.id}_${tgt.id}_${tf.id}`,
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
      const indexLimit = lintProject([
        { id: hit.id, name: hit.name, nodes: nodes.map(toGenNode), edges: edges.map(toGenEdge) },
      ]).find((issue) => issue.rule === "too-many-indexes");
      if (indexLimit) return err(`[TOO_MANY_INDEXES] ${indexLimit.message}`);
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
              ? toTypeScript(gn, ge, allGn)
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
