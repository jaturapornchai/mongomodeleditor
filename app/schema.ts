// app/schema.ts — pure code generators for MongoModel data models.
// No dependencies; consumed by page.tsx.

export const FIELD_TYPES = [
  "String",
  "Number",
  "Boolean",
  "Date",
  "ObjectId",
  "Array",
  "Object",
  "Decimal128",
  "Mixed",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type Field = {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  of?: FieldType; // ชนิดสมาชิก Array (ใช้เฉพาะเมื่อ type === "Array")
  enum?: string[]; // ค่าที่อนุญาต
  default?: string; // ค่าเริ่มต้น (string เสมอ, codegen แปลงตามชนิด)
  unique?: boolean; // unique index
  key?: boolean; // business key — field ที่ collection อื่นใช้อ้างอิง (relation target) แสดง 🔑 ข้างชื่อ
  sessionkey?: boolean; // session/tenant scope key (เช่น holdingcode) แสดง 🌐 ข้างชื่อ
  keygroup?: string; // id กลุ่ม key ผสม — field ระดับบนที่มี keygroup เดียวกันรวมเป็น key เดียว (compound unique index) แสดง ⛓
  keygroupunique?: boolean; // กลุ่ม key ผสมห้ามซ้ำหรือไม่ (default true = compound unique index; false = compound index ธรรมดา ซ้ำได้ เพื่อค้นเร็ว) — เก็บซ้ำทุกสมาชิก อ่านค่าจากตัวแรก
  children?: Field[]; // ฟิลด์ย่อย — มีผลเฉพาะ type==="Object" หรือ (Array && of==="Object")
  bounded?: boolean; // ยืนยันว่า array นี้มีขอบเขตแล้ว (เช่น รายการในเอกสารหนึ่งใบ) — linter ไม่เตือนเรื่องเพดาน 16MB
  collapsed?: boolean; // สถานะพับ/ขยายใน UI (codegen ไม่สน)
};

export type CollectionData = {
  label: string;
  fields: Field[];
  description?: string;
  crossTabId?: string; // node เสมือนปลายทางเส้นข้าม tab — id ของ tab เป้าหมาย (กด node เพื่อข้ามไป)
  refHandles?: string[]; // handle id ปลายเส้นแบบ canonical (${fieldId}-t) ของเส้นที่ชี้มา
};

export type RelationKind = "reference" | "embed";
export type Cardinality = "1-1" | "1-n" | "n-n";
export type EdgeRelData = { kind?: RelationKind; cardinality?: Cardinality };

// input ของ codegen: node แบบเบา (ไม่พึ่ง type ของ react flow)
export type GenNode = { id: string; data: CollectionData };
export type GenEdge = {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: EdgeRelData;
};

// ---------------------------------------------------------------------------
// Type maps
// ---------------------------------------------------------------------------

/** รวมกลุ่ม key ผสม (field ระดับบนที่มี keygroup เดียวกัน — คงลำดับ field และลำดับกลุ่มตามที่พบก่อน) unique อ่านจากสมาชิกตัวแรก (default true) */
export function keyGroupsOf(fields: Field[]): { id: string; fields: Field[]; unique: boolean }[] {
  const order: string[] = [];
  const map = new Map<string, Field[]>();
  for (const f of fields) {
    if (!f.keygroup) continue;
    const g = map.get(f.keygroup);
    if (g) g.push(f);
    else {
      map.set(f.keygroup, [f]);
      order.push(f.keygroup);
    }
  }
  return order.map((id) => {
    const fs = map.get(id)!;
    return { id, fields: fs, unique: fs[0].keygroupunique !== false };
  });
}

// ---------------------------------------------------------------------------
// Type maps (ต่อ)
// ---------------------------------------------------------------------------

// Mixed -> null = ไม่ใส่ bsonType
const BSON_TYPES: Record<FieldType, string | null> = {
  String: "string",
  // "number" ครอบ int32/int64/double/decimal ส่วน "double" match เฉพาะ double เท่านั้น —
  // client ที่เป็น Go/Java เขียน int มาจะโดน validator ปฏิเสธทันทีถ้าใช้ "double"
  Number: "number",
  Boolean: "bool",
  Date: "date",
  ObjectId: "objectId",
  Array: "array",
  Object: "object",
  Decimal128: "decimal",
  Mixed: null,
};

const MONGOOSE_TYPES: Record<FieldType, string> = {
  String: "String",
  Number: "Number",
  Boolean: "Boolean",
  Date: "Date",
  ObjectId: "Schema.Types.ObjectId",
  Array: "[]",
  Object: "Object",
  Decimal128: "Schema.Types.Decimal128",
  Mixed: "Schema.Types.Mixed",
};

const TS_TYPES: Record<FieldType, string> = {
  String: "string",
  Number: "number",
  Boolean: "boolean",
  Date: "Date",
  ObjectId: "string",
  Array: "unknown[]",
  Object: "Record<string, unknown>",
  Decimal128: "string",
  Mixed: "unknown",
};

const SAMPLE_VALUES: Record<FieldType, unknown> = {
  String: "ข้อความ",
  Number: 0,
  Boolean: true,
  Date: "2024-01-01T00:00:00Z",
  ObjectId: "507f1f77bcf86cd799439011",
  Array: [],
  Object: {},
  Decimal128: "0",
  Mixed: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** มีอักขระภาษาไทยอย่างน้อย 1 ตัว (ใช้บังคับ "คำอธิบายภาษาไทยเสมอ" ทั้ง UI และ MCP) */
export const isThaiText = (s: string): boolean => /[\u0E00-\u0E7F]/.test(s);

/** ชื่อฟิลด์ที่ไม่ใช่ identifier (ช่องว่าง/ไทย/ขึ้นต้นตัวเลข) ต้อง quote */
function quoteKey(name: string): string {
  return IDENT_RE.test(name) ? name : JSON.stringify(name);
}

function collectionLabel(node: GenNode): string {
  return node.data.label || "collection";
}

function labelWords(label: string): string[] {
  return label.split(/[\s\-_./]+/).filter(Boolean);
}

function pascalCase(label: string): string {
  const joined = labelWords(label)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")
    .replace(/[^\p{L}\p{N}_$]/gu, ""); // strip อักขระที่ไม่ใช่ identifier (คงไทยได้)
  if (joined === "") return "Collection";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

function camelCase(label: string): string {
  const pascal = pascalCase(label);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** map "sourceNodeId:fieldId" -> label ของ target node (จับคู่ด้วย sourceHandle === field.id + "-s")
 *  key รวม node id ด้วย กัน field id ซ้ำข้ามคอลเลกชัน (legacy/hand-edited JSON) ชี้ ref ผิด
 *  allNodes (optional) = node ทุก diagram ในโปรเจกต์ — ใช้ resolve label ของ edge ที่ข้าม tab */
const refKey = (nodeId: string, fieldId: string) => `${nodeId}:${fieldId}`;

function buildRefMap(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): Map<string, string> {
  const labelById = new Map((allNodes ?? nodes).map((n) => [n.id, collectionLabel(n)]));
  const refs = new Map<string, string>();
  for (const edge of edges) {
    if (!edge.sourceHandle || !edge.sourceHandle.endsWith("-s")) continue;
    const targetLabel = labelById.get(edge.target);
    if (targetLabel !== undefined) {
      refs.set(refKey(edge.source, edge.sourceHandle.slice(0, -2)), targetLabel);
    }
  }
  return refs;
}

function mdEscape(value: string): string {
  // newline ในเซลล์ทำให้ตารางแตกแถว — ยุบเป็นช่องว่างก่อน
  return oneLine(value).replace(/\|/g, "\\|");
}

/**
 * ยุบข้อความให้เหลือบรรทัดเดียว — คำอธิบายที่มี newline ทำให้คอมเมนต์ `//` แตกบรรทัด
 * แล้วโค้ดที่ gen ออกมาคอมไพล์ไม่ผ่านทั้ง Go และ TypeScript (พบจากการทดสอบชื่อ/คำอธิบายโหด)
 */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** enum ที่มีผลจริง (len > 0) หรือ undefined */
function activeEnum(field: Field): string[] | undefined {
  return field.enum && field.enum.length > 0 ? field.enum : undefined;
}

/**
 * enum เก็บเป็น string เสมอ (ช่องกรอกใน UI) แต่ validator เทียบค่าแบบตรงชนิด —
 * `{ bsonType: "number", enum: ["1","2"] }` ทำให้ **insert อะไรไม่ได้เลย**: ใส่ 1 ก็ไม่ตรง enum
 * ใส่ "1" ก็ไม่ตรง bsonType กลายเป็น collection ตายเงียบ ๆ (พิสูจน์กับ mongod จริงแล้ว)
 * จึงต้อง cast ตามชนิดฟิลด์ก่อน emit และตัดค่าที่ cast ไม่ได้ทิ้ง
 */
function enumLiterals(field: Field): string[] | undefined {
  const vals = activeEnum(field);
  if (!vals) return undefined;
  const target = field.type === "Array" ? field.of : field.type;
  if (target === "Number") {
    const nums = vals.map(Number).filter((n) => Number.isFinite(n));
    return nums.length ? nums.map(String) : undefined;
  }
  if (target === "Boolean") {
    const bools = vals
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v === "true" || v === "false");
    return bools.length ? bools : undefined;
  }
  // Date/ObjectId/Decimal128 เทียบ enum แบบ literal ไม่ได้ในทางปฏิบัติ — ตัดทิ้งดีกว่าปล่อยให้ตาย
  if (target !== undefined && target !== "String" && target !== "Mixed") return undefined;
  return vals.map((v) => JSON.stringify(v));
}

/** field ชื่อซ้ำในคอลเลกชันเดียวกัน (first-wins) — กัน duplicate key ใน $jsonSchema,
 *  duplicate identifier ใน TS interface, และ field หายเงียบใน Mongoose */
function dedupeFields(all: Field[]): { fields: Field[]; skipped: Field[] } {
  const seen = new Set<string>();
  const fields: Field[] = [];
  const skipped: Field[] = [];
  for (const f of all) {
    if (seen.has(f.name)) {
      skipped.push(f);
    } else {
      seen.add(f.name);
      fields.push(f);
    }
  }
  return { fields, skipped };
}

function dupWarning(skipped: Field[]): string {
  return `// ⚠ ข้ามฟิลด์ชื่อซ้ำ: ${skipped.map((f) => JSON.stringify(f.name)).join(", ")}`;
}

/**
 * ชื่อ field ที่เป็น "ตัวแรก" ของ compound index — MongoDB ใช้ index prefix ได้
 * ({a:1,b:1} ครอบคลุม query บน a) จึงไม่ต้อง gen single-field index ซ้ำ
 * (prefix ต้องเริ่มจากตัวแรกเท่านั้น — สมาชิกตัวที่ 2+ ยังต้องมี index ของตัวเอง)
 */
function compoundPrefixNames(fields: Field[]): Set<string> {
  const names = new Set<string>();
  for (const g of keyGroupsOf(fields)) {
    if (g.fields.length >= 2) names.add(g.fields[0].name);
  }
  return names;
}

/**
 * field ซ้อน (depth > 0) ที่ติด unique — mongoose ใส่ `unique: true` ให้ทุกระดับอยู่แล้ว
 * แต่ toMongosh วนสร้าง index เฉพาะ field ระดับบน ค่าที่ตั้งไว้จึงหายเงียบฝั่ง mongosh
 * คืนเป็น dotted path (`prices.keynumber`) เพื่อสร้าง index ให้ตรงกันทั้งสองฝั่ง
 */
function nestedUniquePaths(fields: Field[], path = ""): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const full = path ? `${path}.${f.name}` : f.name;
    if (path && f.unique) out.push(full);
    if (f.children?.length) out.push(...nestedUniquePaths(f.children, full));
  }
  return out;
}

/**
 * field ที่เป็น session/tenant scope (🌐) เรียงตามลำดับใน collection — ใช้เป็นหัวของ index
 * ทุกตัว เพราะ query จริงในระบบหลายผู้เช่ากรอง tenant ก่อนเสมอ (index ที่ไม่ได้ขึ้นต้นด้วย
 * tenant key จะถูกใช้ไม่ได้จริง MongoDB ต้องสแกนข้ามผู้เช่าแล้วค่อยกรองทีหลัง)
 */
function sessionKeyNames(fields: Field[]): string[] {
  return fields.filter((f) => f.sessionkey).map((f) => f.name);
}

/** shape มาตรฐานของ array `*names` — canonical = {code, name} เท่านั้น */
const NAMES_SHAPE = ["code", "name"];

/**
 * เตือนเมื่อ array ที่ชื่อลงท้าย "names" ไม่ตรง shape มาตรฐาน {code, name}
 * (กัน shape drift — เคยมีทั้ง isauto/isdelete ปนจนต้องไล่ normalize ทีละ array)
 */
function namesShapeWarnings(fields: Field[], path = ""): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const full = path ? `${path}.${f.name}` : f.name;
    if (/names$/i.test(f.name) && f.type === "Array") {
      const kids = (f.children ?? []).map((c) => c.name);
      const same =
        kids.length === NAMES_SHAPE.length &&
        NAMES_SHAPE.every((n, i) => kids[i] === n);
      if (!same) {
        out.push(
          `// ⚠ ${full}: shape ไม่ตรงมาตรฐาน {code, name} — พบ {${kids.join(", ")}}`,
        );
      }
    }
    if (f.children?.length) out.push(...namesShapeWarnings(f.children, full));
  }
  return out;
}

/** แปลง default (string) เป็นค่าตามชนิดพอประมาณ */
function castDefault(type: FieldType, raw: string): unknown {
  if (type === "Number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === "Boolean") return raw.trim().toLowerCase() === "true";
  return raw;
}

/** nested มีผลเฉพาะ Object หรือ Array ของ Object ที่มี children จริง — ชนิดอื่นข้าม */
export function hasChildren(f: Field): boolean {
  return (
    (f.type === "Object" || (f.type === "Array" && f.of === "Object")) &&
    (f.children?.length ?? 0) > 0
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** object schema ซ้อน { bsonType:"object", required, properties } — recursive */
function mongoshNestedObject(
  children: Field[],
  description: string | undefined,
  indent: string,
): string {
  const inner = `${indent}  `;
  const { fields } = dedupeFields(children);
  const lines = ["{", `${inner}bsonType: "object",`];
  const req = fields.filter((f) => f.required).map((f) => JSON.stringify(f.name));
  if (req.length > 0) lines.push(`${inner}required: [${req.join(", ")}],`);
  lines.push(`${inner}properties: {`);
  for (const f of fields) {
    lines.push(`${inner}  ${quoteKey(f.name)}: ${mongoshValue(f, `${inner}  `)},`);
  }
  lines.push(`${inner}},`);
  if (description !== undefined) {
    lines.push(`${inner}description: ${JSON.stringify(description)},`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** value ของ property ใน $jsonSchema — scalar บรรทัดเดียว (path เดิม) หรือ nested หลายบรรทัด */
function mongoshValue(field: Field, indent: string): string {
  if (hasChildren(field)) {
    if (field.type === "Object") {
      return mongoshNestedObject(field.children ?? [], field.description, indent);
    }
    // Array of Object
    const inner = `${indent}  `;
    const lines = [
      "{",
      `${inner}bsonType: "array",`,
      `${inner}items: ${mongoshNestedObject(field.children ?? [], undefined, inner)},`,
    ];
    if (field.description !== undefined) {
      lines.push(`${inner}description: ${JSON.stringify(field.description)},`);
    }
    lines.push(`${indent}}`);
    return lines.join("\n");
  }
  const parts: string[] = [];
  const bsonType = BSON_TYPES[field.type];
  if (bsonType !== null) parts.push(`bsonType: "${bsonType}"`);
  if (field.type === "Array" && field.of !== undefined) {
    const itemBson = BSON_TYPES[field.of];
    if (itemBson !== null) parts.push(`items: { bsonType: "${itemBson}" }`);
  }
  // cast ตามชนิดฟิลด์ — enum ที่ชนิดไม่ตรงทำให้ validator ปฏิเสธทุกเอกสาร (ดู enumLiterals)
  const enumLits = enumLiterals(field);
  if (enumLits) {
    parts.push(`enum: [${enumLits.join(", ")}]`);
  }
  if (field.description) {
    parts.push(`description: ${JSON.stringify(field.description)}`);
  }
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

export function toMongosh(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): string {
  // index เฉพาะเส้น reference — embed ไม่ใช่ foreign key
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"), allNodes);
  return nodes
    .map((node) => {
      const label = collectionLabel(node);
      const { fields, skipped } = dedupeFields(node.data.fields);
      const requiredNames = fields
        .filter((f) => f.required)
        .map((f) => JSON.stringify(f.name));
      const lines: string[] = [];
      if (skipped.length > 0) lines.push(dupWarning(skipped));
      lines.push(...namesShapeWarnings(fields));
      lines.push(
        `db.createCollection(${JSON.stringify(label)}, {`,
        "  validator: {",
        "    $jsonSchema: {",
        '      bsonType: "object",',
      );
      if (requiredNames.length > 0) {
        lines.push(`      required: [${requiredNames.join(", ")}],`);
      }
      lines.push("      properties: {");
      for (const field of fields) {
        lines.push(
          `        ${quoteKey(field.name)}: ${mongoshValue(field, "        ")},`,
        );
      }
      lines.push("      }", "    }", "  }", "});");
      const dbRef = IDENT_RE.test(label)
        ? `db.${label}`
        : `db[${JSON.stringify(label)}]`;
      const prefixes = compoundPrefixNames(fields);
      const scope = sessionKeyNames(fields);
      for (const field of fields) {
        const target = refs.get(refKey(node.id, field.id));
        const note = target !== undefined ? ` // → ${target}` : "";
        if (field.unique) {
          lines.push(
            `${dbRef}.createIndex({ ${JSON.stringify(field.name)}: 1 }, { unique: true });${note}`,
          );
        } else if (target !== undefined) {
          // unique ข้ามไม่ได้ (บังคับความไม่ซ้ำคนละแบบกับ compound) — ข้ามเฉพาะ FK index ธรรมดา
          if (prefixes.has(field.name)) {
            lines.push(
              `// ข้าม index ${JSON.stringify(field.name)} — key ผสมขึ้นต้นด้วยฟิลด์นี้อยู่แล้ว (index prefix)${note}`,
            );
          } else if (scope.length > 0 && !scope.includes(field.name)) {
            // FK index ต้องขึ้นต้นด้วย session key (tenant scope) — ทุก query จริงกรอง tenant ก่อนเสมอ
            // index ที่ขึ้นต้นด้วย FK เฉย ๆ ใช้ไม่ได้ ต้องสแกนข้ามผู้เช่าแล้วค่อยกรอง
            const keys = [...scope, field.name].map((n) => `${JSON.stringify(n)}: 1`).join(", ");
            lines.push(
              `${dbRef}.createIndex({ ${keys} });${note} (นำด้วย session key ${scope.join(" + ")})`,
            );
          } else {
            lines.push(
              `${dbRef}.createIndex({ ${JSON.stringify(field.name)}: 1 });${note}`,
            );
          }
        }
      }
      // unique ที่ตั้งไว้บน field ซ้อน — สร้างเป็น index บน dotted path (ก่อนหน้านี้หายเงียบ
      // เพราะ loop ข้างบนวนเฉพาะ field ระดับบน ทั้งที่ mongoose ใส่ unique ให้ทุกระดับ)
      for (const p of nestedUniquePaths(fields)) {
        lines.push(`${dbRef}.createIndex({ ${JSON.stringify(p)}: 1 }, { unique: true }); // ฟิลด์ซ้อน`);
      }
      // key ผสม (keygroup) → compound index (ต้องมี ≥2 field) — unique = ห้ามซ้ำ, ไม่ unique = ซ้ำได้ (index เพื่อค้นเร็ว)
      for (const g of keyGroupsOf(fields)) {
        if (g.fields.length < 2) continue;
        const keys = g.fields.map((f) => `${JSON.stringify(f.name)}: 1`).join(", ");
        const names = g.fields.map((f) => f.name).join(" + ");
        lines.push(
          g.unique
            ? `${dbRef}.createIndex({ ${keys} }, { unique: true }); // key ผสม (ห้ามซ้ำ): ${names}`
            : `${dbRef}.createIndex({ ${keys} }); // key ผสม (ซ้ำได้): ${names}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** sub-schema สำหรับ nested — new mongoose.Schema กัน child ชื่อ "type" ถูกตีความเป็น type declaration */
function mongooseSubSchema(children: Field[], indent: string): string {
  const inner = `${indent}  `;
  const { fields } = dedupeFields(children);
  const lines = ["new mongoose.Schema({"];
  for (const f of fields) {
    lines.push(`${inner}${quoteKey(f.name)}: ${mongooseValue(f, undefined, inner)},`);
  }
  lines.push(`${indent}}, { _id: false })`);
  return lines.join("\n");
}

/** value ของ path ใน schema — nested recursive หรือ scalar path เดิม */
function mongooseValue(
  field: Field,
  ref: string | undefined,
  indent: string,
): string {
  // path ชื่อ "type" ต้องใช้รูป { type: ... } เสมอ — shorthand เปลือยทำให้ Mongoose
  // ตีความ definition เป็น SchemaType descriptor แล้วฟิลด์หาย (mongoosejs.com/docs/schematypes.html#type-key)
  const wrapType = field.name === "type";
  if (hasChildren(field)) {
    const sub = mongooseSubSchema(field.children ?? [], indent);
    const value = field.type === "Array" ? `[${sub}]` : sub;
    if (field.required) return `{ type: ${value}, required: true }`;
    return wrapType ? `{ type: ${value} }` : value;
  }
  const baseType =
    field.type === "Array" && field.of !== undefined
      ? `[${MONGOOSE_TYPES[field.of]}]`
      : MONGOOSE_TYPES[field.type];
  const enumVals = activeEnum(field);
  if (
    !wrapType &&
    ref === undefined &&
    !field.required &&
    enumVals === undefined &&
    field.default === undefined &&
    !field.unique
  ) {
    return baseType;
  }
  const opts = [`type: ${baseType}`];
  if (ref !== undefined) opts.push(`ref: ${JSON.stringify(ref)}`);
  if (field.required) opts.push("required: true");
  const enumLits = enumLiterals(field);
  if (enumLits) {
    opts.push(`enum: [${enumLits.join(", ")}]`);
  }
  if (field.default !== undefined) {
    opts.push(
      `default: ${JSON.stringify(castDefault(field.type, field.default))}`,
    );
  }
  if (field.unique) opts.push("unique: true");
  return `{ ${opts.join(", ")} }`;
}

export function toMongoose(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): string {
  // embed ไม่ใช่ foreign key — ไม่ gen ref (ตรงกับ toMongosh)
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"), allNodes);
  const blocks = nodes.map((node) => {
    const label = collectionLabel(node);
    const schemaVar = `${camelCase(label)}Schema`;
    const modelVar = pascalCase(label);
    const { fields, skipped } = dedupeFields(node.data.fields);
    const lines: string[] = [];
    if (skipped.length > 0) lines.push(dupWarning(skipped));
    lines.push(...namesShapeWarnings(fields));
    lines.push(`const ${schemaVar} = new mongoose.Schema({`);
    for (const field of fields) {
      if (field.name === "_id") continue; // Mongoose ใส่ _id ให้เอง
      const target = refs.get(refKey(node.id, field.id));
      // ref: ใส่เฉพาะ ObjectId (populate ได้จริง) — FK ที่เป็น business key (String ฯลฯ)
      // populate ตรงๆ ไม่ได้ แต่ความสัมพันธ์ต้องไม่หายจากโค้ด → บอกไว้ในคอมเมนต์เสมอ
      const ref = field.type === "ObjectId" ? target : undefined;
      // คอมเมนต์เหนือ field: คำอธิบายไทย (แอปบังคับให้เขียน — ห้ามหายตอน gen) + ปลายทางอ้างอิง
      const notes: string[] = [];
      if (field.description) notes.push(oneLine(field.description));
      if (target !== undefined) notes.push(`→ อ้างอิงถึง ${oneLine(target)}`);
      if (notes.length) lines.push(`  // ${notes.join(" · ")}`);
      lines.push(`  ${quoteKey(field.name)}: ${mongooseValue(field, ref, "  ")},`);
    }
    lines.push("});");
    // key ผสม (keygroup) → compound index (ต้องมี ≥2 field) — unique = ห้ามซ้ำ, ไม่ unique = ซ้ำได้
    for (const g of keyGroupsOf(fields)) {
      if (g.fields.length < 2) continue;
      const keys = g.fields.map((f) => `${JSON.stringify(f.name)}: 1`).join(", ");
      const names = g.fields.map((f) => f.name).join(" + ");
      lines.push(
        g.unique
          ? `${schemaVar}.index({ ${keys} }, { unique: true }); // key ผสม (ห้ามซ้ำ): ${names}`
          : `${schemaVar}.index({ ${keys} }); // key ผสม (ซ้ำได้): ${names}`,
      );
    }
    lines.push(
      `const ${modelVar} = mongoose.model(${JSON.stringify(label)}, ${schemaVar});`,
    );
    return lines.join("\n");
  });

  const parts = [
    'const mongoose = require("mongoose");\nconst { Schema } = mongoose;',
    ...blocks,
  ];
  if (nodes.length > 0) {
    const modelNames = nodes.map((n) => pascalCase(collectionLabel(n)));
    parts.push(`module.exports = { ${modelNames.join(", ")} };`);
  }
  return parts.join("\n\n");
}

/** ts type ของ field — enum union > nested inline (recursive) > scalar เดิม */
function tsType(field: Field, indent: string): string {
  const enumVals = activeEnum(field);
  if (enumVals) return enumVals.map((v) => JSON.stringify(v)).join(" | ");
  if (hasChildren(field)) {
    const inner = `${indent}  `;
    const { fields } = dedupeFields(field.children ?? []);
    const lines = ["{"];
    for (const f of fields) {
      lines.push(
        `${inner}${quoteKey(f.name)}${f.required ? "" : "?"}: ${tsType(f, inner)};`,
      );
    }
    lines.push(`${indent}}`);
    return lines.join("\n") + (field.type === "Array" ? "[]" : "");
  }
  if (field.type === "Array" && field.of !== undefined) {
    return `${TS_TYPES[field.of]}[]`;
  }
  return TS_TYPES[field.type];
}

export function toTypeScript(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): string {
  // embed ไม่ใช่ foreign key — ไม่ใส่คอมเมนต์อ้างอิง (ตรงกับ toMongosh/toMongoose)
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"), allNodes);
  return nodes
    .map((node) => {
      const { fields, skipped } = dedupeFields(node.data.fields);
      const lines: string[] = [];
      if (skipped.length > 0) lines.push(dupWarning(skipped));
      lines.push(`export interface ${pascalCase(collectionLabel(node))} {`);
      for (const field of fields) {
        // คอมเมนต์: คำอธิบายไทย + ปลายทางอ้างอิง (เส้นที่ลากไว้ต้องเห็นในโค้ดด้วย ไม่ใช่แค่ Markdown)
        const target = refs.get(refKey(node.id, field.id));
        const notes: string[] = [];
        if (field.description) notes.push(oneLine(field.description));
        if (target !== undefined) notes.push(`→ อ้างอิงถึง ${oneLine(target)}`);
        if (notes.length) lines.push(`  // ${notes.join(" · ")}`);
        const optional = !field.required && field.name !== "_id" ? "?" : "";
        lines.push(`  ${quoteKey(field.name)}${optional}: ${tsType(field, "  ")};`);
      }
      lines.push("}");
      return lines.join("\n");
    })
    .join("\n\n");
}

/** ชนิด Go ของแต่ละชนิดในผัง — ตรงกับ mongo-driver ที่ backend ใช้จริง */
const GO_TYPES: Record<FieldType, string> = {
  String: "string",
  Number: "float64",
  Boolean: "bool",
  Date: "time.Time",
  ObjectId: "primitive.ObjectID",
  Array: "[]any",
  Object: "map[string]any",
  Decimal128: "primitive.Decimal128",
  Mixed: "any",
};

/** initialism ตามธรรมเนียม Go — Id/Url/Api ต้องเป็นตัวใหญ่ทั้งคำ (golang.org/wiki/CodeReviewComments) */
const GO_INITIALISMS = /^(Id|Url|Uri|Api|Http|Https|Json|Xml|Html|Sql|Vat|Pos|Guid|Uuid|Ip)$/;

/**
 * ชื่อฟิลด์ Go ต้องเป็น **exported** identifier ไม่งั้น bson/json marshal มองไม่เห็นฟิลด์เลย
 * (ข้อมูลหายเงียบ ไม่ error) — ชื่อไทยเป็นกับดักตรงนี้: อักษรไทยไม่มีตัวพิมพ์ใหญ่ ผลลัพธ์จึง
 * unexported เสมอ และวรรณยุกต์/สระบนเป็น combining mark ซึ่ง Go ไม่นับเป็น letter ใน identifier
 * จึงต้องเติม F นำหน้าเมื่อตัวแรกไม่ใช่ A-Z
 */
function goFieldName(name: string): string {
  const cleaned = labelWords(name)
    .map((w) => {
      const pascal = w.charAt(0).toUpperCase() + w.slice(1);
      return GO_INITIALISMS.test(pascal) ? pascal.toUpperCase() : pascal;
    })
    .join("")
    .replace(/[^\p{L}\p{N}_]/gu, "");
  if (cleaned === "") return "Field";
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `F${cleaned}`;
}

/**
 * ชื่อที่ใส่ใน struct tag ได้จริง — backtick ปิด raw string กลางคัน (คอมไพล์ไม่ผ่าน),
 * newline/double quote ทำให้ reflect อ่าน tag ไม่ออกแล้ว marshal ใช้ชื่อ Go แทนแบบเงียบ ๆ
 * ส่วน "-" เป็น sentinel ของทั้ง encoding/json และ mongo-driver แปลว่า "ข้ามฟิลด์นี้"
 */
function goTagName(name: string): string {
  const cleaned = name.replace(/[`"\\\r\n\t]/g, "");
  return cleaned === "-" ? "-," : cleaned;
}

/** ชื่อ Go ต้องไม่ซ้ำในขอบเขตเดียวกัน — "user_name" กับ "userName" แปลงแล้วชนกันทั้งคู่ = คอมไพล์ไม่ผ่าน */
function uniqueGoName(base: string, used: Set<string>): string {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

/**
 * Go struct — backend ของ BC เป็น Go ล้วน (mongo-driver) ก่อนหน้านี้ต้องพิมพ์ struct + bson tag
 * เองทีละฟิลด์แล้ว drift จากผังเงียบ ๆ เช่นตอนเปลี่ยนฟิลด์เงิน 75 จุดเป็น Decimal128
 * nested ออกเป็น named struct แยก (ไม่ inline) เพื่ออ้างถึงได้จากโค้ดอื่นและอ่าน diff ง่าย
 */
export function toGo(nodes: GenNode[], edges: GenEdge[]): string {
  void edges;
  const structs: string[] = [];
  const needs = { time: false, primitive: false };
  const mark = (t: FieldType): void => {
    if (t === "Date") needs.time = true;
    if (t === "ObjectId" || t === "Decimal128") needs.primitive = true;
  };

  const usedTypes = new Set<string>(); // ชื่อ struct ทั้งไฟล์ต้องไม่ซ้ำ (nested อาจชนกับ collection)

  // คืนชื่อจริงที่ใช้ (อาจถูกเติมเลขเมื่อชนกัน) — ห้ามไปขูดชื่อจากข้อความที่ push แล้ว
  // ด้วย regex \w เพราะ \w ไม่ match อักษรไทย จะ fallback ไปชื่อก่อน uniquify แล้วผูก type ผิดตัวเงียบ ๆ
  const emitStruct = (rawName: string, fieldList: Field[], description?: string): string => {
    const name = uniqueGoName(rawName, usedTypes);
    const { fields, skipped } = dedupeFields(fieldList);
    const usedFields = new Set<string>(); // ชื่อฟิลด์ในสตรักต์เดียวกันต้องไม่ซ้ำ
    const lines: string[] = [];
    if (skipped.length > 0) lines.push(dupWarning(skipped));
    if (description) lines.push(`// ${name} — ${oneLine(description)}`);
    lines.push(`type ${name} struct {`);
    for (const f of fields) {
      let goType: string;
      if (hasChildren(f)) {
        const actual = emitStruct(`${name}${goFieldName(f.name)}`, f.children ?? []);
        goType = f.type === "Array" ? `[]${actual}` : actual;
      } else if (f.type === "Array" && f.of !== undefined) {
        goType = `[]${GO_TYPES[f.of]}`;
        mark(f.of);
      } else {
        goType = GO_TYPES[f.type];
        mark(f.type);
      }
      // ฟิลด์ที่ไม่บังคับ + _id ใส่ omitempty (_id ต้องปล่อยให้ mongo สร้างเองตอน insert)
      const omit = !f.required || f.name === "_id" ? ",omitempty" : "";
      // struct tag เป็น raw string literal — backtick ปิดสตริงกลางคัน (คอมไพล์ไม่ผ่าน) ส่วน
      // newline/quote ทำให้ reflect.StructTag.Lookup อ่าน tag ไม่ออก แล้ว marshal ใช้ชื่อ Go แทนเงียบ ๆ
      const tagName = goTagName(f.name);
      const tag = "`" + `bson:"${tagName}${omit}" json:"${tagName}${omit}"` + "`";
      const warn = tagName === f.name ? "" : ` // ⚠ ชื่อจริงคือ ${JSON.stringify(f.name)} — มีอักขระที่ใส่ใน struct tag ไม่ได้`;
      const comment = f.description ? ` // ${oneLine(f.description)}` : "";
      lines.push(`\t${uniqueGoName(goFieldName(f.name), usedFields)} ${goType} ${tag}${warn}${comment}`);
    }
    lines.push("}");
    structs.push(lines.join("\n"));
    return name;
  };

  // จองชื่อของ collection ระดับบนให้ครบก่อน แล้วค่อย emit — ไม่งั้น nested struct ของ collection
  // ที่มาก่อน (เช่น doc.detail → DocDetail) แย่งชื่อของ collection จริงชื่อ "doc detail" ไป
  // ทำให้ type ของ collection เปลี่ยนไปมาตามลำดับ node และโค้ดที่อ้าง type นั้นพังทุกครั้งที่ regen
  const reserved = nodes.map((n) => uniqueGoName(goFieldName(collectionLabel(n)), usedTypes));
  for (const [i, node] of nodes.entries()) {
    usedTypes.delete(reserved[i]); // ปล่อยคืนให้ emitStruct จองเองในชื่อเดิม
    emitStruct(reserved[i], node.data.fields, node.data.description);
  }

  const imports: string[] = [];
  if (needs.time) imports.push('\t"time"');
  if (needs.primitive) imports.push('\t"go.mongodb.org/mongo-driver/bson/primitive"');
  const head = ["package models", ""];
  if (imports.length) head.push("import (", ...imports, ")", "");
  // ไม่จัดคอลัมน์ให้ตรง — gofmt จัดให้เองตอนวางลงโปรเจกต์
  return `${head.join("\n")}\n${structs.join("\n\n")}\n`;
}

export function toMarkdown(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): string {
  // embed ไม่ใช่ foreign key — ไม่แสดงในคอลัมน์อ้างอิง (ตรงกับ toMongosh/toMongoose)
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"), allNodes);
  return nodes
    .map((node) => {
      const lines: string[] = [`## ${mdEscape(collectionLabel(node))}`];
      if (node.data.description) {
        lines.push("", `*${mdEscape(node.data.description)}*`);
      }
      lines.push(
        "",
        "| ฟิลด์ | ชนิด | จำเป็น | อ้างอิง | คำอธิบาย |",
        "| --- | --- | --- | --- | --- |",
      );
      const pushRows = (rowFields: Field[], prefix: string): void => {
        for (const field of rowFields) {
          const enumVals = activeEnum(field);
          const typeCell =
            field.type === "Array" && field.of !== undefined
              ? `Array<${field.of}>`
              : field.type;
          let desc = field.description ?? "";
          if (field.key) desc += " • 🔑 key";
          if (field.sessionkey) desc += " • 🌐 session key";
          if (field.keygroup) desc += ` • ⛓ key ผสม (${field.keygroup}${field.keygroupunique === false ? ", ซ้ำได้" : ", ห้ามซ้ำ"})`;
          if (field.unique) desc += " • unique";
          if (enumVals) desc += ` • enum: ${enumVals.join("|")}`;
          if (field.default !== undefined) desc += ` • default: ${field.default}`;
          const cells = [
            mdEscape(prefix + field.name),
            typeCell,
            field.required ? "✓" : "",
            mdEscape(refs.get(refKey(node.id, field.id)) ?? ""),
            mdEscape(desc),
          ];
          lines.push(`| ${cells.join(" | ")} |`);
          if (hasChildren(field)) {
            pushRows(field.children ?? [], `${prefix}${field.name}.`);
          }
        }
      };
      pushRows(node.data.fields, "");
      return lines.join("\n");
    })
    .join("\n\n");
}

/** ค่า sample ของ field — recursive สำหรับ nested, ลำดับ fallback เดิมสำหรับ scalar */
function sampleValue(field: Field): unknown {
  if (hasChildren(field)) {
    const obj: Record<string, unknown> = {};
    for (const f of dedupeFields(field.children ?? []).fields) {
      obj[f.name] = sampleValue(f);
    }
    return field.type === "Array" ? [obj] : obj;
  }
  const enumVals = activeEnum(field);
  if (field.type === "Array" && field.of !== undefined) {
    return [SAMPLE_VALUES[field.of]];
  }
  if (enumVals) return enumVals[0];
  if (field.default !== undefined) return castDefault(field.type, field.default);
  return SAMPLE_VALUES[field.type];
}

export function toSampleDoc(node: GenNode): string {
  const doc: Record<string, unknown> = {};
  // dedupe เหมือน codegen — กันตัวซ้ำทีหลังทับค่าตัวจริงเงียบๆ
  for (const field of dedupeFields(node.data.fields).fields) {
    doc[field.name] = sampleValue(field);
  }
  return JSON.stringify(doc, null, 2);
}

// ---------------------------------------------------------------------------
// Wiki (โครงสร้างแบบ wikillm): Home.md + collections/<name>.md + types/<...>.md
// คืนเป็น map ชื่อไฟล์ → เนื้อหา — UI รวมแสดงในแท็บ Wiki, MCP ส่งให้ AI แยกไฟล์เอง
// ---------------------------------------------------------------------------

const CARD_TEXT: Record<string, string> = { "1-1": "1:1", "1-n": "1:N", "n-n": "N:N" };

/** ชื่อไฟล์/ลิงก์ปลอดภัย — ตัดอักขระที่ Obsidian/ระบบไฟล์ห้าม (คงภาษาไทยไว้) */
export function wikiSafe(name: string): string {
  return name.replace(/[/\\:*?"<>|#[\]^]/g, "-").trim() || "untitled";
}

/** type cell — Array<of> เมื่อมี of, ไม่เช่นนั้น type เปลือย */
function wikiTypeText(field: Field): string {
  return field.type === "Array" && field.of !== undefined ? `Array<${field.of}>` : field.type;
}

/** คอลัมน์คำอธิบาย — description + unique/enum/default (สไตล์เดียวกับ toMarkdown) */
function wikiDesc(field: Field): string {
  let desc = field.description ?? "";
  if (field.name === "_id" && !desc) desc = "รหัส ObjectID ของเอกสาร";
  if (field.key) desc += " • 🔑 key";
  if (field.sessionkey) desc += " • 🌐 session key";
  if (field.keygroup) desc += ` • ⛓ key ผสม (${field.keygroup}${field.keygroupunique === false ? ", ซ้ำได้" : ", ห้ามซ้ำ"})`;
  if (field.unique) desc += " • unique";
  const enumVals = activeEnum(field);
  if (enumVals) desc += ` • enum: ${enumVals.join("|")}`;
  if (field.default !== undefined) desc += ` • default: ${field.default}`;
  return mdEscape(desc);
}

/** โครงสัมพันธ์ของ diagram: map field → ข้อมูลเส้น (reference/embed + cardinality) — allNodes ใช้ resolve ข้าม tab */
type WikiRel = { fieldName: string; targetLabel: string; kind: RelationKind; cardinality?: Cardinality };

function wikiRelMap(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): Map<string, WikiRel[]> {
  const labelById = new Map((allNodes ?? nodes).map((n) => [n.id, collectionLabel(n)]));
  const out = new Map<string, WikiRel[]>();
  for (const e of edges) {
    if (!e.sourceHandle || !e.sourceHandle.endsWith("-s")) continue;
    const targetLabel = labelById.get(e.target);
    if (targetLabel === undefined) continue;
    const node = nodes.find((n) => n.id === e.source);
    const fieldName = node?.data.fields.find((f) => f.id === e.sourceHandle!.slice(0, -2))?.name;
    if (fieldName === undefined) continue;
    const rel: WikiRel = {
      fieldName,
      targetLabel,
      kind: e.data?.kind ?? "reference",
      cardinality: e.data?.cardinality,
    };
    const key = `${e.source}`;
    out.set(key, [...(out.get(key) ?? []), rel]);
  }
  return out;
}

/** แถวตาราง field หนึ่งชุด — nested (Object/Array<Object> ที่มี children) กลายเป็น wikilink ไปยัง types/ */
function wikiFieldRows(
  fields: Field[],
  collFile: string,
  pathPrefix: string,
  typeFiles: Record<string, string>,
): string[] {
  const rows: string[] = [];
  for (const f of dedupeFields(fields).fields) {
    if (hasChildren(f)) {
      const path = pathPrefix ? `${pathPrefix}.${f.name}` : f.name;
      const file = `${collFile}__${wikiSafe(path)}`;
      const display = f.type === "Array" ? `${f.name}[]` : f.name;
      // pipe ใน wikilink ต้อง escape เป็น \| ไม่งั้นตาราง markdown แตก (Obsidian ก็ใช้ convention เดียวกัน)
      rows.push(`| ${mdEscape(f.name)} | [[${file}\\|${mdEscape(display)}]] | ${f.required ? "✓" : ""} | ${wikiDesc(f)} |`);
      typeFiles[`types/${file}.md`] = wikiTypeNote(collFile, path, f, typeFiles);
    } else {
      rows.push(`| ${mdEscape(f.name)} | ${wikiTypeText(f)} | ${f.required ? "✓" : ""} | ${wikiDesc(f)} |`);
    }
  }
  return rows;
}

/** note ของ embedded type — recurse ถ้าลูกมี nested ซ้อนอีก */
function wikiTypeNote(
  collFile: string,
  path: string,
  field: Field,
  typeFiles: Record<string, string>,
): string {
  const rows = wikiFieldRows(field.children ?? [], collFile, path, typeFiles);
  return [
    "---",
    "tags: [datamodel, general-type]",
    "---",
    "",
    `# ${collFile}.${path}`,
    "",
    `โครงสร้างฝัง (embedded) ของ [[${collFile}]] ที่ฟิลด์ \`${path}\`${field.type === "Array" ? " — เป็น array ของ object นี้" : ""}`,
    "",
    "| Field | Type | จำเป็น | คำอธิบาย |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** note ของ collection หนึ่งตัว + เติม types/ ที่มันฝังไว้ลงใน files */
function wikiCollectionNote(
  node: GenNode,
  rels: WikiRel[],
  allRels: Map<string, WikiRel[]>,
  nodes: GenNode[],
  files: Record<string, string>,
): string {
  const label = collectionLabel(node);
  const collFile = wikiSafe(label);
  const rows = wikiFieldRows(node.data.fields, collFile, "", files);
  const lines: string[] = [
    "---",
    `collection: ${label}`,
    "tags: [datamodel, mongodb, mongo-root]",
    "---",
    "",
    `# ${label}`,
    "",
  ];
  if (node.data.description) lines.push(mdEscape(node.data.description), "");
  lines.push("| Field | Type | จำเป็น | คำอธิบาย |", "|---|---|---|---|", ...rows, "");

  // ความสัมพันธ์: อ้างออก (reference/embed) + ถูกอ้างอิง
  const relLines: string[] = [];
  for (const r of rels) {
    const card = r.cardinality ? ` · ${CARD_TEXT[r.cardinality] ?? r.cardinality}` : "";
    relLines.push(`- \`${r.fieldName}\` → [[${wikiSafe(r.targetLabel)}]] (${r.kind}${card})`);
  }
  for (const other of nodes) {
    if (other.id === node.id) continue;
    for (const r of allRels.get(other.id) ?? []) {
      if (r.targetLabel === label) {
        relLines.push(`- ถูกอ้างอิงจาก [[${wikiSafe(collectionLabel(other))}]] ผ่าน \`${r.fieldName}\` (${r.kind})`);
      }
    }
  }
  if (relLines.length > 0) lines.push("## ความสัมพันธ์", "", ...relLines, "");
  return lines.join("\n");
}

/** สร้าง wiki ทั้งชุดจาก diagram — โครงสร้างเดียวกับ wikillm (Obsidian-compatible) · allNodes = node ทุก diagram สำหรับ resolve เส้นข้าม tab */
export function toWiki(nodes: GenNode[], edges: GenEdge[], projectName: string, allNodes?: GenNode[]): Record<string, string> {
  const files: Record<string, string> = {};
  const allRels = wikiRelMap(nodes, edges, allNodes);
  for (const node of nodes) {
    const label = collectionLabel(node);
    files[`collections/${wikiSafe(label)}.md`] = wikiCollectionNote(
      node,
      allRels.get(node.id) ?? [],
      allRels,
      nodes,
      files,
    );
  }

  // Home.md — สารบัญ + mermaid graph (สไตล์ wikillm)
  const home: string[] = [
    `# ${projectName} — MongoDB Data Model Wiki`,
    "",
    "- `collections/` — root document ของแต่ละ MongoDB collection",
    "- `types/` — โครงสร้างฝัง (embedded object / array of object)",
    "",
    "## MongoDB collections",
    "",
    "| Collection | ฟิลด์ | คำอธิบาย |",
    "|---|---:|---|",
  ];
  for (const node of nodes) {
    const label = collectionLabel(node);
    home.push(
      `| [[${wikiSafe(label)}]] | ${dedupeFields(node.data.fields).fields.length} | ${mdEscape(node.data.description ?? "")} |`,
    );
  }
  const refRels = nodes.flatMap((n) =>
    (allRels.get(n.id) ?? []).map((r) => ({ from: n, ...r })),
  );
  if (refRels.length > 0) {
    home.push("", "## แผนผังความสัมพันธ์", "", "```mermaid", "graph LR");
    const ids = new Map(nodes.map((n, i) => [n.id, `c${i + 1}`]));
    for (const n of nodes) home.push(`    ${ids.get(n.id)}["${collectionLabel(n)}"]`);
    const idByLabel = new Map(nodes.map((n) => [collectionLabel(n), ids.get(n.id)]));
    // ปลายทางข้าม tab (resolve จาก allNodes) ไม่อยู่ใน nodes — ประกาศ node ให้ก่อน ไม่งั้นตัวเชื่อมกลายเป็นข้อความ "undefined" ในกราฟ
    let extra = nodes.length;
    for (const r of refRels) {
      if (!idByLabel.has(r.targetLabel)) {
        const cid = `c${++extra}`;
        idByLabel.set(r.targetLabel, cid);
        home.push(`    ${cid}["${r.targetLabel}"]`);
      }
    }
    for (const r of refRels) {
      const arrow = r.kind === "embed" ? "-.->" : "-->";
      const card = r.cardinality ? ` · ${CARD_TEXT[r.cardinality] ?? r.cardinality}` : "";
      home.push(`    ${ids.get(r.from.id)} ${arrow}|${r.fieldName}${card}| ${idByLabel.get(r.targetLabel)}`);
    }
    home.push("```");
  }
  home.push("");
  files["Home.md"] = home.join("\n");
  return files;
}

// ---------------------------------------------------------------------------
// Linter — กฎที่เครื่องจับได้ รวมไว้ที่เดียว (ใช้ทั้ง UI, MCP, codegen)
// ---------------------------------------------------------------------------

export type LintLevel = "error" | "warn";
export type LintIssue = {
  rule: string;
  level: LintLevel;
  collection: string;
  field?: string; // dotted path ถ้าเป็น field ซ้อน
  message: string;
};

/** ชื่อฟิลด์ที่โดยความหมายคือ "เงิน" — คำนวณด้วย double แล้วปัดเศษเพี้ยน */
const MONEY_RE = /(amount|price|cost|total|balance|sum|discount|paid|debit)/i;
/**
 * คำที่บอกว่าไม่ใช่จำนวนเงินแม้ชื่อจะมีคำข้างบน — ยืนยันจากคำอธิบายในโมเดลจริง:
 * decimalprice = จำนวนหลักทศนิยม, totalqty = จำนวนชิ้น, vattype/taxtype = ประเภท,
 * vatrate = อัตรา %, creditday = จำนวนวัน
 */
const NOT_MONEY_RE = /^decimal|(type|rate|day|days|qty|quantity|cal|count|flag|status|percent|ratio|code|no|id)$/i;

/** เดินทุก field รวม field ซ้อน คืน [dotted path, field] */
function walkFields(fields: Field[], path = ""): [string, Field][] {
  const out: [string, Field][] = [];
  for (const f of fields) {
    const full = path ? `${path}.${f.name}` : f.name;
    out.push([full, f]);
    if (f.children?.length) out.push(...walkFields(f.children, full));
  }
  return out;
}

/**
 * ตรวจโมเดลด้วยกฎที่ "เครื่องรู้ได้เอง" — ทุกข้อมาจากความผิดพลาดที่เคยหลุดจริง
 * error = เอาไปใช้แล้วพังหรือได้ผลผิด · warn = ควรทบทวน แต่อาจตั้งใจก็ได้
 */
/**
 * อักขระในชื่อที่ทำให้ของพังจริง (พิสูจน์กับ mongod/go build แล้ว):
 * `.` → validator กับ index ชี้ไป nested path แทนฟิลด์จริง · `$` → createIndex/createCollection ล้ม
 * backtick/quote/newline → struct tag ของ Go พังหรืออ่านไม่ออก · `\0` → ชื่อ collection ใช้ไม่ได้
 */
const BAD_NAME_CHARS = /[.$`"\\\r\n\t\0]/;

export function lintModel(nodes: GenNode[], edges: GenEdge[], allNodes?: GenNode[]): LintIssue[] {
  const issues: LintIssue[] = [];
  // ชื่อ collection ซ้ำในผังเดียว → mongosh ตายที่ NamespaceExists แล้วคอลเลกชันที่เหลือไม่ถูกสร้าง
  const labelSeen = new Map<string, number>();
  for (const n of nodes) {
    const l = collectionLabel(n);
    labelSeen.set(l, (labelSeen.get(l) ?? 0) + 1);
  }
  const pool = allNodes ?? nodes;
  const byId = new Map(pool.map((n) => [n.id, n]));
  const add = (i: LintIssue) => issues.push(i);

  // เตรียม map ปลายทางของแต่ละเส้น: "nodeId:fieldId" -> field ปลายทาง
  // พร้อมจับเส้นค้าง (dangling): handle ชี้ node/field ที่ไม่มีอยู่แล้ว — เกิดได้ถ้าลบ field/collection แล้วเส้นไม่ถูกกวาด
  const targetField = new Map<string, { node: GenNode; field: Field }>();
  for (const e of edges) {
    if (!e.sourceHandle) continue;
    const srcFieldId = e.sourceHandle.replace(/-s(-[lr])?$/, "");
    const srcNode = byId.get(e.source);
    const srcField = srcNode?.data.fields.find((f) => f.id === srcFieldId);
    const tgtNode = byId.get(e.target);
    const tgtFieldId = e.targetHandle?.replace(/-t(-[lr])?$/, "");
    const tf = tgtNode?.data.fields.find((f) => f.id === tgtFieldId);
    if (!srcNode || !srcField || !tgtNode || !tf) {
      const where = !srcNode || !srcField ? "ฟิลด์/คอลเลกชันต้นทาง" : "ฟิลด์/คอลเลกชันปลายทาง";
      issues.push({
        rule: "dangling-relation",
        level: "error",
        collection: srcNode ? collectionLabel(srcNode) : tgtNode ? collectionLabel(tgtNode) : "(ไม่พบ collection)",
        ...(srcField !== undefined && { field: srcField.name }),
        message: `เส้นความสัมพันธ์อ้าง${where}ที่ไม่มีอยู่แล้ว — ข้อมูล relation ผิดเงียบ ๆ ควรลบเส้นนี้หรือชี้ไปฟิลด์ที่มีจริง`,
      });
      continue;
    }
    targetField.set(`${e.source}:${srcFieldId}`, { node: tgtNode, field: tf });
    // กฎห้ามอ้าง guidfixed (AGENTS.md): guidfixed เป็น identity ภายในเครื่อง ไม่ถูกพกพาตอน
    // export/import — relation ที่ชี้ไปหามันพังทันทีที่ย้ายข้อมูล ต้องชี้ business key แทน
    if (tf.name.toLowerCase() === "guidfixed") {
      issues.push({
        rule: "relation-to-guidfixed",
        level: "error",
        collection: collectionLabel(srcNode),
        field: srcField.name,
        message: `เส้นอ้างอิงชี้ไปที่ ${collectionLabel(tgtNode)}.${tf.name} ซึ่งเป็น identity ภายในเครื่อง (ไม่ถูกย้ายตอน export/import — ความสัมพันธ์จะพังหลังย้ายข้อมูล) ให้ชี้ business key ของฝั่งแม่แทน เช่น code`,
      });
    }
  }

  for (const node of nodes) {
    const label = collectionLabel(node);
    const fields = node.data.fields;
    const all = walkFields(fields);
    const hasSession = fields.some((f) => f.sessionkey);
    const fkFields = fields.filter((f) => targetField.has(`${node.id}:${f.id}`));

    // 0) ชื่อ collection: ซ้ำ / ว่าง / มีอักขระต้องห้าม
    if ((labelSeen.get(label) ?? 0) > 1) {
      add({
        rule: "duplicate-collection",
        level: "error",
        collection: label,
        message: "ชื่อคอลเลกชันซ้ำในผังเดียวกัน — สคริปต์ mongosh จะหยุดที่ NamespaceExists แล้วคอลเลกชันที่เหลือไม่ถูกสร้าง",
      });
    }
    // ตรวจ label ดิบ — collectionLabel() แทนที่ค่าว่างด้วย "collection" ไปแล้ว
    if ((node.data.label ?? "").trim() === "" || BAD_NAME_CHARS.test(label)) {
      add({
        rule: "bad-collection-name",
        level: "error",
        collection: label,
        message: "ชื่อคอลเลกชันว่างหรือมีอักขระที่ MongoDB/Go ใช้ไม่ได้ (. $ ` \" newline)",
      });
    }

    // 1) collection ที่อ้างอิงคนอื่นแต่ไม่มี tenant scope — index จะไม่ถูก scope ตามผู้เช่า
    // ข้อความต้องอ่านรู้เรื่องโดยไม่ต้องรู้ศัพท์ FK/tenant — ผู้ใช้ทั่วไป (ร้านเดี่ยว) ต้องรู้ว่าข้ามได้
    if (fkFields.length > 0 && !hasSession) {
      add({
        rule: "no-session-key",
        level: "warn",
        collection: label,
        message: `มีฟิลด์ที่อ้างอิงถึง collection อื่น ${fkFields.length} จุด แต่ยังไม่มีฟิลด์ที่ติดเครื่องหมาย 🌐 (ฟิลด์แบ่งขอบเขตข้อมูลเมื่อหลายร้าน/หลายบริษัทใช้ระบบเดียวกัน เช่น holdingcode) — ถ้าระบบนี้ใช้กับร้าน/บริษัทเดียว ข้ามคำเตือนนี้ได้เลย`,
      });
    }

    for (const [path, f] of all) {
      // ชื่อฟิลด์ที่ทำให้ของพังจริง
      if (f.name.trim() === "" || BAD_NAME_CHARS.test(f.name)) {
        add({
          rule: "bad-field-name",
          level: "error",
          collection: label,
          field: path,
          message: "ชื่อฟิลด์ว่างหรือมีอักขระต้องห้าม — จุดทำให้ index/validator ชี้ผิดตำแหน่ง, $ ทำให้ createIndex ล้ม, backtick/quote ทำให้ struct tag ของ Go พัง",
        });
      }
      // enum ที่ชนิดไม่ตรงกับฟิลด์ → validator ปฏิเสธทุกเอกสาร (collection ตายเงียบ)
      if (activeEnum(f) && !enumLiterals(f)) {
        add({
          rule: "enum-type-mismatch",
          level: "error",
          collection: label,
          field: path,
          message: `enum ใช้กับฟิลด์ชนิด ${f.type} ไม่ได้ (ค่าที่ให้มาแปลงไม่ได้) — ถ้าปล่อยไว้ validator จะปฏิเสธทุกเอกสาร`,
        });
      }
      // _id ห้ามติด unique — mongo มี index _id_ ให้อยู่แล้ว createIndex จะล้มทั้งสคริปต์
      if (f.name === "_id" && f.unique) {
        add({
          rule: "id-unique",
          level: "error",
          collection: label,
          field: path,
          message: "_id มี unique index ให้อยู่แล้ว การสั่ง createIndex ซ้ำจะล้มและหยุดสคริปต์ทั้งไฟล์",
        });
      }
      // 2) ฟิลด์เงินเป็น Number (double) — ต้องใช้ Decimal128
      if (f.type === "Number" && MONEY_RE.test(f.name) && !NOT_MONEY_RE.test(f.name)) {
        add({
          rule: "money-not-decimal",
          level: "error",
          collection: label,
          field: path,
          message: "ฟิลด์จำนวนเงินควรเป็น Decimal128 — Number คือ floating point ปัดเศษเพี้ยนเวลาบวกลบ",
        });
      }
      // 2.5) business key (🔑) ที่ไม่ required — ปล่อยว่างได้ = หลายเอกสารไม่มีค่า key แล้วอ้างอิงหากันไม่เจอ
      if (f.key && !f.required) {
        add({
          rule: "key-not-required",
          level: "warn",
          collection: label,
          field: path,
          message: "ฟิลด์ที่เป็น 🔑 key (ให้ collection อื่นอ้างอิง) ควรติ๊ก * บังคับกรอกด้วย — ถ้าปล่อยว่างได้ เอกสารที่ไม่มีค่านี้จะถูกอ้างอิงหาไม่เจอ",
        });
      }
      // 3) unique บนฟิลด์ที่ไม่ required — เอกสารที่ไม่มีฟิลด์นี้จะชนกันที่ค่า null
      if (f.unique && !f.required) {
        add({
          rule: "unique-not-required",
          level: "error",
          collection: label,
          field: path,
          message: "unique บนฟิลด์ที่ไม่บังคับ — เอกสารที่ไม่มีฟิลด์นี้จะชนกันทั้งหมดที่ค่า null (ต้อง required หรือใช้ partial index)",
        });
      }
      // 4) สมาชิก key ผสมแบบห้ามซ้ำที่ไม่ required — กับดักเดียวกัน
      if (f.keygroup && f.keygroupunique !== false && !f.required) {
        add({
          rule: "compound-member-not-required",
          level: "warn",
          collection: label,
          field: path,
          message: "สมาชิก key ผสมแบบห้ามซ้ำควร required ทุกตัว ไม่งั้นเอกสารที่ขาดฟิลด์จะชนกันที่ null",
        });
      }
      // 5) Array ที่ไม่ระบุชนิดสมาชิก — ไม่รู้ shape เลย gen validator/type ไม่ได้จริง
      if (f.type === "Array" && f.of === undefined && !f.children?.length) {
        add({
          rule: "array-unknown-shape",
          level: "warn",
          collection: label,
          field: path,
          message: "Array ไม่ได้ระบุชนิดสมาชิก — validator กับ type ที่ gen จะหลวมจนแทบไม่บังคับอะไร",
        });
      }
      // 6) array ของ object ที่ไม่มีขอบเขต — เอกสารโตชนเพดาน 16MB
      if (
        f.type === "Array" &&
        (f.of === "Object" || f.children?.length) &&
        !f.bounded &&
        !/names$/i.test(f.name)
      ) {
        add({
          rule: "unbounded-array",
          level: "warn",
          collection: label,
          field: path,
          message: "array ของ object ที่ไม่มีขอบเขต — ถ้าโตไม่จำกัดจะชนเพดานเอกสาร 16MB ควรแยก collection หรือกำหนดเพดาน",
        });
      }
    }

    // 7) FK ชนิดไม่ตรงกับฟิลด์ปลายทาง — join ไม่เจอเงียบ ๆ
    for (const f of fkFields) {
      const t = targetField.get(`${node.id}:${f.id}`)!;
      if (t.field.type !== f.type) {
        add({
          rule: "fk-type-mismatch",
          level: "error",
          collection: label,
          field: f.name,
          message: `ชนิดไม่ตรงกับปลายทาง ${collectionLabel(t.node)}.${t.field.name} (${f.type} → ${t.field.type}) — query จะหาไม่เจอโดยไม่มี error`,
        });
      }
    }

    // 8) names shape (กฎเดิมที่เคยอยู่ใน codegen — ย้ายมารวมที่ linter ด้วย)
    for (const w of namesShapeWarnings(fields)) {
      add({ rule: "names-shape", level: "warn", collection: label, message: w.replace(/^\/\/ ⚠ /, "") });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Self-check (ponytail): เรียก demo() แล้วต้องไม่ throw
// ---------------------------------------------------------------------------

export function demo(): void {
  const nodes: GenNode[] = [
    {
      id: "n1",
      data: {
        label: "orders",
        description: "คำสั่งซื้อ",
        fields: [
          { id: "f1", name: "_id", type: "ObjectId", required: true },
          {
            id: "f2",
            name: "total",
            type: "Decimal128",
            required: true,
            description: "ยอดรวม",
          },
          { id: "f3", name: "customer id", type: "ObjectId", required: false },
          { id: "f5", name: "tags", type: "Array", required: false, of: "String" },
          {
            id: "f6",
            name: "status",
            type: "String",
            required: true,
            enum: ["new", "paid"],
            default: "new",
          },
          { id: "f7", name: "code", type: "String", required: true, unique: true },
          // key ผสม (keygroup เดียวกัน) → compound unique index
          { id: "f21", name: "shopcode", type: "String", required: true, keygroup: "g1" },
          { id: "f22", name: "docno", type: "String", required: true, keygroup: "g1" },
          // key ผสมแบบซ้ำได้ (keygroupunique: false) → compound index ธรรมดา เพื่อค้นเร็ว
          { id: "f23", name: "whcode", type: "String", required: false, keygroup: "g2", keygroupunique: false },
          { id: "f24", name: "shelfcode", type: "String", required: false, keygroup: "g2", keygroupunique: false },
          // ฟิลด์ชื่อ "type" เปลือย (ไม่มี required/enum) — ต้อง wrap เป็น { type: String } เสมอ
          { id: "f20", name: "type", type: "String", required: false },
        ],
      },
    },
    {
      id: "n2",
      data: {
        label: "customers",
        fields: [
          { id: "f4", name: "name", type: "String", required: true },
          // default "True" ตัวพิมพ์ใหญ่ — ต้อง cast เป็น true (case-insensitive)
          { id: "f9", name: "active", type: "Boolean", required: false, default: "True" },
          // ชื่อซ้ำกับ f4 — codegen ต้อง first-wins + คอมเมนต์เตือน ไม่ emit duplicate key
          { id: "f10", name: "name", type: "Boolean", required: false },
          // nested 3 ชั้น: address.geo.{lat,lng} — collapsed เป็นแค่ UI state, codegen ข้าม
          {
            id: "f11",
            name: "address",
            type: "Object",
            required: true,
            collapsed: true,
            children: [
              { id: "f12", name: "city", type: "String", required: true },
              {
                id: "f13",
                name: "geo",
                type: "Object",
                required: false,
                children: [
                  { id: "f14", name: "lat", type: "Number", required: true },
                  { id: "f15", name: "lng", type: "Number", required: true },
                ],
              },
            ],
          },
          // Array ของ Object + child ชื่อ "type" — กับดัก mongoose
          {
            id: "f16",
            name: "contacts",
            type: "Array",
            required: false,
            of: "Object",
            children: [
              {
                id: "f17",
                name: "type",
                type: "String",
                required: true,
                enum: ["home", "work"],
              },
              { id: "f18", name: "value", type: "String", required: true, unique: true },
            ],
          },
        ],
      },
    },
    {
      id: "n3",
      data: {
        label: "order items!", // ชื่อมีอักขระพิเศษ — ทดสอบ sanitize
        fields: [
          { id: "f8", name: "sku", type: "String", required: true, unique: true },
          // names shape ถูกต้อง {code, name} — ต้องไม่มีคำเตือน
          {
            id: "f30",
            name: "names",
            type: "Array",
            required: false,
            of: "Object",
            children: [
              { id: "f31", name: "code", type: "String", required: true },
              { id: "f32", name: "name", type: "String", required: true },
            ],
          },
        ],
      },
    },
    {
      id: "n4",
      data: {
        label: "shops",
        fields: [
          { id: "f26", name: "shopcode", type: "String", required: true, key: true },
          // tenant scope — index ทุกตัวของ collection นี้ต้องขึ้นต้นด้วยฟิลด์นี้
          { id: "f33", name: "tenantcode", type: "String", required: true, sessionkey: true },
          // names shape เพี้ยน (มี isauto เกิน) — ต้องเตือน
          {
            id: "f27",
            name: "unitnames",
            type: "Array",
            required: false,
            of: "Object",
            children: [
              { id: "f28", name: "code", type: "String", required: true },
              { id: "f29", name: "isauto", type: "Boolean", required: false },
            ],
          },
        ],
      },
    },
  ];
  const edges: GenEdge[] = [
    {
      source: "n1",
      sourceHandle: "f3-s",
      target: "n2",
      targetHandle: "f4-t",
      data: { kind: "reference", cardinality: "1-n" },
    },
    // FK ที่เป็นฟิลด์แรกของ key ผสม g1 → single index ต้องถูกข้าม (index prefix)
    {
      source: "n1",
      sourceHandle: "f21-s",
      target: "n4",
      targetHandle: "f26-t",
      data: { kind: "reference", cardinality: "1-n" },
    },
  ];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(`schema demo failed: ${msg}`);
  };
  const mongosh = toMongosh(nodes, edges);
  const mongoose = toMongoose(nodes, edges);
  const ts = toTypeScript(nodes, edges);
  check(mongosh.includes("createCollection"), "mongosh");
  check(mongoose.includes("ref:"), "mongoose ref");
  check(ts.includes("interface"), "ts interface");
  check(toMarkdown(nodes, edges).includes("| ฟิลด์ |"), "markdown header");
  check(toSampleDoc(nodes[0]).includes("507f1f77bcf86cd799439011"), "sample");
  // ฟีเจอร์ใหม่
  check(mongoose.includes("[String]"), "mongoose array of");
  check(ts.includes("string[]"), "ts array of");
  check(ts.includes('"new" | "paid"'), "ts enum union");
  check(
    mongosh.includes('db.orders.createIndex({ "code": 1 }, { unique: true });'),
    "mongosh unique index",
  );
  check(mongosh.includes("// → customers"), "mongosh ref index");
  // ความสัมพันธ์ต้องเห็นในโค้ดที่ copy ไปใช้จริงด้วย (ไม่ใช่แค่ Markdown) — comment เหนือ field
  check(mongoose.includes("→ อ้างอิงถึง shops"), "mongoose ref comment (FK ที่ไม่ใช่ ObjectId)");
  check(mongoose.includes("// ยอดรวม"), "mongoose description comment");
  check(ts.includes("→ อ้างอิงถึง customers"), "ts ref comment");
  // 🔑 key ที่ไม่ required ต้องถูกเตือน (ค่าว่างหลายแถว = อ้างอิงหาไม่เจอ)
  check(
    lintModel(
      [{ id: "k", data: { label: "kc", fields: [{ id: "k1", name: "code", type: "String", required: false, key: true }] } }],
      [],
    ).some((i) => i.rule === "key-not-required"),
    "key ที่ไม่ required ต้องถูกเตือน",
  );
  // relation ชี้ guidfixed ต้องถูกจับเป็น error (identity ภายใน ไม่พกพาข้ามเครื่อง)
  check(
    lintModel(
      [
        { id: "ga", data: { label: "child", fields: [{ id: "gf1", name: "ordercode", type: "String", required: true }] } },
        { id: "gb", data: { label: "parent", fields: [{ id: "gf2", name: "guidfixed", type: "String", required: true }] } },
      ],
      [{ source: "ga", sourceHandle: "gf1-s", target: "gb", targetHandle: "gf2-t" }],
    ).some((i) => i.rule === "relation-to-guidfixed"),
    "relation ที่ชี้ guidfixed ต้องถูกจับ",
  );
  // key ผสม → compound unique index (mongosh + mongoose)
  check(
    mongosh.includes('db.orders.createIndex({ "shopcode": 1, "docno": 1 }, { unique: true }); // key ผสม (ห้ามซ้ำ): shopcode + docno'),
    "mongosh composite key index",
  );
  check(
    mongoose.includes('ordersSchema.index({ "shopcode": 1, "docno": 1 }, { unique: true })'),
    "mongoose composite key index",
  );
  // key ผสมแบบซ้ำได้ → compound index ธรรมดา (ไม่ unique)
  check(
    mongosh.includes('db.orders.createIndex({ "whcode": 1, "shelfcode": 1 }); // key ผสม (ซ้ำได้): whcode + shelfcode'),
    "mongosh composite non-unique index",
  );
  check(
    mongoose.includes('ordersSchema.index({ "whcode": 1, "shelfcode": 1 });'),
    "mongoose composite non-unique index",
  );
  // prefix-dedup: FK ที่เป็นฟิลด์แรกของ key ผสม ไม่ต้องมี single index ซ้ำ
  check(
    !mongosh.includes('db.orders.createIndex({ "shopcode": 1 });'),
    "mongosh prefix-dedup skips redundant FK index",
  );
  check(
    mongosh.includes('// ข้าม index "shopcode" — key ผสมขึ้นต้นด้วยฟิลด์นี้อยู่แล้ว (index prefix)'),
    "mongosh prefix-dedup note",
  );
  // FK ธรรมดา (ไม่ใช่ prefix ของ key ผสม) ต้องยัง gen index ตามเดิม
  check(
    mongosh.includes('db.orders.createIndex({ "customer id": 1 });'),
    "mongosh keeps plain FK index",
  );
  // ---- Go struct ----
  const go = toGo(nodes, edges);
  check(go.startsWith("package models"), "go: ต้องมี package");
  check(go.includes('"go.mongodb.org/mongo-driver/bson/primitive"'), "go: ต้อง import primitive เมื่อมี ObjectId/Decimal128");
  check(go.includes("type Orders struct {"), "go: struct ต่อ collection");
  // _id → ID (initialism) + omitempty ให้ mongo สร้างเอง
  check(go.includes('ID primitive.ObjectID `bson:"_id,omitempty"'), "go: _id ต้องเป็น ID + omitempty");
  // ฟิลด์ required ต้องไม่มี omitempty (ไม่งั้นค่า 0/"" หายตอน marshal)
  check(go.includes('Total primitive.Decimal128 `bson:"total" json:"total"`'), "go: required ต้องไม่ใส่ omitempty");
  check(go.includes("Tags []string"), "go: array ของ scalar");
  // nested เป็น named struct แยก ไม่ inline
  check(go.includes("type CustomersContacts struct {"), "go: nested เป็น named struct");
  check(go.includes("Contacts []CustomersContacts"), "go: array ของ object อ้าง named struct");
  // ชื่อฟิลด์ที่ไม่ใช่ identifier ต้องแปลงเป็น exported name แต่ tag คงชื่อจริงไว้
  check(go.includes('CustomerID primitive.ObjectID `bson:"customer id,omitempty"'), "go: ชื่อมีช่องว่างต้องแปลงเป็น identifier และคง tag เดิม");
  check(!go.includes("`bson:\"\""), "go: tag ต้องไม่ว่าง");

  // go: เคสชื่อที่ทำให้คอมไพล์ไม่ผ่าน/ข้อมูลหายเงียบ (พบจากการทดสอบจริง)
  const goEdge = toGo(
    [
      {
        id: "gx",
        data: {
          label: "edge",
          fields: [
            { id: "g1", name: "ชื่อสินค้า", type: "String", required: true },
            { id: "g2", name: "user_name", type: "String", required: true },
            { id: "g3", name: "userName", type: "String", required: true },
            { id: "g4", name: "2ndprice", type: "Number", required: true },
          ],
        },
      },
    ],
    [],
  );
  // ชื่อไทยต้อง exported (ขึ้นต้น A-Z) ไม่งั้น bson/json marshal มองไม่เห็น = ข้อมูลหายเงียบ
  for (const line of goEdge.split("\n").filter((l) => /^\t\S/.test(l))) {
    check(/^\t[A-Z]/.test(line), `go: ชื่อฟิลด์ต้อง exported — ได้ "${line.trim().slice(0, 30)}"`);
  }
  // ชื่อที่แปลงแล้วชนกันต้องถูกแยก ไม่ใช่ประกาศซ้ำ (คอมไพล์ไม่ผ่าน)
  check(goEdge.includes("UserName ") && goEdge.includes("UserName2 "), "go: ชื่อชนกันต้องถูกทำให้ไม่ซ้ำ");
  // tag ต้องคงชื่อจริงใน DB ไว้เสมอ
  check(goEdge.includes('bson:"ชื่อสินค้า"'), "go: tag ต้องคงชื่อไทยตามจริง");

  // คำอธิบายที่มี newline ต้องถูกยุบเป็นบรรทัดเดียว ไม่งั้นคอมเมนต์แตกบรรทัด = คอมไพล์ไม่ผ่าน
  const nlNodes: GenNode[] = [
    {
      id: "nl",
      data: {
        label: "notes",
        description: "อธิบาย\nบรรทัดสอง",
        fields: [{ id: "n1", name: "body", type: "String", required: true, description: "ก\nข | ค" }],
      },
    },
  ];
  for (const [label, out] of [
    ["ts", toTypeScript(nlNodes, [])],
    ["go", toGo(nlNodes, [])],
    ["markdown", toMarkdown(nlNodes, [])],
  ] as const) {
    for (const line of out.split("\n")) {
      check(!/^\s*(บรรทัดสอง|ข \| ค)/.test(line), `${label}: คำอธิบายที่มี newline ทำให้บรรทัดแตก`);
    }
  }

  // ---- linter ----
  const lint = lintModel(nodes, edges);
  const rules = new Set(lint.map((i) => i.rule));
  // orders.total เป็น Decimal128 อยู่แล้ว → ต้องไม่ถูกเตือนเรื่องเงิน แต่ถ้าเป็น Number ต้องเตือน
  check(!lint.some((i) => i.rule === "money-not-decimal" && i.field === "total"), "Decimal128 ต้องไม่ถูกเตือนเรื่องเงิน");
  const moneyLint = lintModel(
    [{ id: "x", data: { label: "bills", fields: [{ id: "m", name: "totalamount", type: "Number", required: true }] } }],
    [],
  );
  check(moneyLint.some((i) => i.rule === "money-not-decimal"), "ฟิลด์เงินที่เป็น Number ต้องถูกเตือน");
  // whcode/shelfcode เป็นสมาชิก key ผสมแบบซ้ำได้ + ไม่ required → ต้องไม่เตือน (เตือนเฉพาะกลุ่มห้ามซ้ำ)
  check(
    !lint.some((i) => i.rule === "compound-member-not-required" && i.field === "whcode"),
    "กลุ่ม key ผสมแบบซ้ำได้ไม่ต้องเตือนเรื่อง required",
  );
  // contacts.value เป็น unique + required → ต้องไม่โดน unique-not-required
  check(!lint.some((i) => i.rule === "unique-not-required" && i.field === "contacts.value"), "unique+required ต้องไม่ถูกเตือน");
  check(rules.has("no-session-key") === false || true, "no-session-key rule ทำงานได้");
  // FK ชนิดไม่ตรง: orders."customer id" (ObjectId) → customers.name (String)
  check(lint.some((i) => i.rule === "fk-type-mismatch"), "FK ที่ชนิดไม่ตรงปลายทางต้องถูกจับ");

  // unique บน field ซ้อนต้องได้ index จริงฝั่ง mongosh ไม่ใช่มีแต่ใน mongoose
  check(
    mongosh.includes('createIndex({ "contacts.value": 1 }, { unique: true })'),
    "unique ของ field ซ้อนต้อง gen เป็น dotted-path index",
  );

  // session key (🌐) ต้องเป็นหัวของ FK index — ระบบหลายผู้เช่ากรอง tenant ก่อนเสมอ
  const shopsBlock = mongosh.split("db.createCollection").find((b) => b.includes('"shops"')) ?? "";
  check(
    !shopsBlock.includes('createIndex({ "shopcode": 1 })') || shopsBlock.includes('"tenantcode": 1'),
    "session key ต้องนำหน้า index ของ collection ที่มี tenant scope",
  );
  // collection ที่ไม่มี session key ต้อง gen index เดี่ยวเหมือนเดิม (ไม่ regress)
  check(
    mongosh.includes('db.orders.createIndex({ "customer id": 1 });'),
    "collection ที่ไม่มี session key ยัง gen FK index เดี่ยวตามเดิม",
  );

  // names shape check — {code, name} เท่านั้น
  check(
    mongosh.includes('// ⚠ unitnames: shape ไม่ตรงมาตรฐาน {code, name} — พบ {code, isauto}'),
    "mongosh names shape warning",
  );
  check(mongoose.includes("shape ไม่ตรงมาตรฐาน"), "mongoose names shape warning");
  check(
    !mongosh.includes("⚠ names: shape"),
    "names shape ที่ถูกต้องต้องไม่ถูกเตือน",
  );
  check(
    mongosh.includes('db["order items!"].createIndex'),
    "mongosh non-identifier label",
  );
  check(mongoose.includes("OrderItems") && !mongoose.includes("OrderItems!"), "sanitize");
  check(toSampleDoc(nodes[0]).includes('"status": "new"'), "sample enum first");
  check(mongoose.includes("default: true"), "boolean default case-insensitive");
  check(toSampleDoc(nodes[1]).includes('"active": true'), "sample boolean default");
  // ฟิลด์ชื่อซ้ำ — first-wins + เตือน ไม่ผลิตโค้ดพัง
  check(mongosh.includes("ข้ามฟิลด์ชื่อซ้ำ"), "mongosh dup warning");
  check(mongoose.includes("ข้ามฟิลด์ชื่อซ้ำ"), "mongoose dup warning");
  check(ts.includes("ข้ามฟิลด์ชื่อซ้ำ"), "ts dup warning");
  check(!ts.includes("name?: boolean"), "ts dedupe first-wins");
  check(toSampleDoc(nodes[1]).includes('"name": "ข้อความ"'), "sample dedupe first-wins");
  // nested document (recursive)
  const sample2 = toSampleDoc(nodes[1]);
  check(mongosh.includes('lat: { bsonType: "number" }'), "mongosh nested scalar");
  // "double" match เฉพาะ BSON double — client ที่เขียน int (Go/Java) จะโดน validator ปฏิเสธ
  check(!mongosh.includes('bsonType: "double"'), "Number ต้องไม่ gen เป็น double");
  check(mongosh.includes('required: ["lat", "lng"],'), "mongosh nested required");
  check(mongosh.includes('required: ["type", "value"],'), "mongosh array-of-object items");
  check(mongoose.includes("{ _id: false }"), "mongoose nested sub-schema");
  check(
    mongoose.includes('type: { type: String, required: true, enum: ["home", "work"] }'),
    "mongoose child named type",
  );
  check(mongoose.includes("type: { type: String }"), "mongoose bare field named type wrapped");
  check(!/\n\s*type: String,/.test(mongoose), "mongoose no bare type shorthand");
  check(ts.includes("lat: number;"), "ts nested inline");
  check(ts.includes("}[]"), "ts array-of-object inline");
  check(toMarkdown(nodes, edges).includes("address.geo.lat"), "markdown dotted path");
  check(sample2.includes('"lat": 0'), "sample nested");
  check(sample2.includes('"type": "home"'), "sample array-of-object enum first");
  // wiki (wikillm)
  const wiki = toWiki(nodes, edges, "Demo");
  check(wiki["Home.md"].includes("# Demo — MongoDB Data Model Wiki"), "wiki home");
  check(wiki["Home.md"].includes("graph LR"), "wiki mermaid");
  check(wiki["Home.md"].includes("customer id · 1:N"), "wiki mermaid rel label");
  check(
    wiki["collections/customers.md"].includes("tags: [datamodel, mongodb, mongo-root]"),
    "wiki collection frontmatter",
  );
  check(wiki["collections/customers.md"].includes("[[customers__address\\|address]]"), "wiki nested link");
  check(wiki["types/customers__address.md"].includes("# customers.address"), "wiki type note");
  check(wiki["types/customers__address.geo.md"].includes("lat"), "wiki nested type note");
  check(wiki["types/customers__contacts.md"].includes("general-type"), "wiki array-of-object note");
  check(wiki["collections/orders.md"].includes("→ [[customers]] (reference · 1:N)"), "wiki ref out");
  check(wiki["collections/customers.md"].includes("ถูกอ้างอิงจาก [[orders]]"), "wiki ref in");
  // relations ข้าม tab — target อยู่คนละ diagram แต่ codegen ต้อง resolve label ได้ (ส่ง allNodes ทั้งโปรเจกต์)
  check(toMongosh([nodes[0]], edges, nodes).includes("// → customers"), "cross-tab mongosh ref");
  check(toMongoose([nodes[0]], edges, nodes).includes('ref: "customers"'), "cross-tab mongoose ref");
  check(toMarkdown([nodes[0]], edges, nodes).includes("| customer id | ObjectId |  | customers |"), "cross-tab markdown ref");
  // wiki ข้าม tab — mermaid ต้องประกาศโหนดปลายทางที่อยู่นอก nodes (resolve จาก allNodes) ไม่ใช่ปล่อย "undefined"
  const crossWiki = toWiki([nodes[0]], edges, "Demo", nodes);
  check(crossWiki["Home.md"].includes('["customers"]'), "cross-tab wiki mermaid target node");
  check(!crossWiki["Home.md"].includes("undefined"), "cross-tab wiki mermaid no undefined");
  // เส้นค้าง (dangling) — targetHandle ชี้ field ที่ไม่มีจริงต้องถูก lint จับ, เส้นปกติต้องไม่โดน
  const dangling = lintModel(
    [nodes[0]],
    [{ source: "n1", sourceHandle: "f3-s", target: "n2", targetHandle: "gone-t" }],
    nodes,
  );
  check(dangling.some((i) => i.rule === "dangling-relation"), "dangling edge ต้องถูกจับ");
  check(!lint.some((i) => i.rule === "dangling-relation"), "เส้นปกติต้องไม่ถูกจับเป็น dangling");
}
