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
  children?: Field[]; // ฟิลด์ย่อย — มีผลเฉพาะ type==="Object" หรือ (Array && of==="Object")
  collapsed?: boolean; // สถานะพับ/ขยายใน UI (codegen ไม่สน)
};

export type CollectionData = {
  label: string;
  fields: Field[];
  description?: string;
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

// Mixed -> null = ไม่ใส่ bsonType
const BSON_TYPES: Record<FieldType, string | null> = {
  String: "string",
  Number: "double",
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
  return value.replace(/\|/g, "\\|");
}

/** enum ที่มีผลจริง (len > 0) หรือ undefined */
function activeEnum(field: Field): string[] | undefined {
  return field.enum && field.enum.length > 0 ? field.enum : undefined;
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
  const enumVals = activeEnum(field);
  if (enumVals) {
    parts.push(`enum: [${enumVals.map((v) => JSON.stringify(v)).join(", ")}]`);
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
      for (const field of fields) {
        const target = refs.get(refKey(node.id, field.id));
        const note = target !== undefined ? ` // → ${target}` : "";
        if (field.unique) {
          lines.push(
            `${dbRef}.createIndex({ ${JSON.stringify(field.name)}: 1 }, { unique: true });${note}`,
          );
        } else if (target !== undefined) {
          lines.push(
            `${dbRef}.createIndex({ ${JSON.stringify(field.name)}: 1 });${note}`,
          );
        }
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
  if (enumVals) {
    opts.push(`enum: [${enumVals.map((v) => JSON.stringify(v)).join(", ")}]`);
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
    lines.push(`const ${schemaVar} = new mongoose.Schema({`);
    for (const field of fields) {
      if (field.name === "_id") continue; // Mongoose ใส่ _id ให้เอง
      const ref =
        field.type === "ObjectId" ? refs.get(refKey(node.id, field.id)) : undefined;
      lines.push(`  ${quoteKey(field.name)}: ${mongooseValue(field, ref, "  ")},`);
    }
    lines.push("});");
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

export function toTypeScript(nodes: GenNode[], edges: GenEdge[]): string {
  void edges;
  return nodes
    .map((node) => {
      const { fields, skipped } = dedupeFields(node.data.fields);
      const lines: string[] = [];
      if (skipped.length > 0) lines.push(dupWarning(skipped));
      lines.push(`export interface ${pascalCase(collectionLabel(node))} {`);
      for (const field of fields) {
        if (field.description) lines.push(`  // ${field.description}`);
        const optional = !field.required && field.name !== "_id" ? "?" : "";
        lines.push(`  ${quoteKey(field.name)}${optional}: ${tsType(field, "  ")};`);
      }
      lines.push("}");
      return lines.join("\n");
    })
    .join("\n\n");
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
              { id: "f18", name: "value", type: "String", required: true },
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
  check(mongosh.includes('lat: { bsonType: "double" }'), "mongosh nested scalar");
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
}
