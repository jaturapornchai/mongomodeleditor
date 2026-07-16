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
 *  key รวม node id ด้วย กัน field id ซ้ำข้ามคอลเลกชัน (legacy/hand-edited JSON) ชี้ ref ผิด */
const refKey = (nodeId: string, fieldId: string) => `${nodeId}:${fieldId}`;

function buildRefMap(nodes: GenNode[], edges: GenEdge[]): Map<string, string> {
  const labelById = new Map(nodes.map((n) => [n.id, collectionLabel(n)]));
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export function toMongosh(nodes: GenNode[], edges: GenEdge[]): string {
  // index เฉพาะเส้น reference — embed ไม่ใช่ foreign key
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"));
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
        const parts: string[] = [];
        const bsonType = BSON_TYPES[field.type];
        if (bsonType !== null) parts.push(`bsonType: "${bsonType}"`);
        if (field.type === "Array" && field.of !== undefined) {
          const itemBson = BSON_TYPES[field.of];
          if (itemBson !== null) parts.push(`items: { bsonType: "${itemBson}" }`);
        }
        const enumVals = activeEnum(field);
        if (enumVals) {
          parts.push(
            `enum: [${enumVals.map((v) => JSON.stringify(v)).join(", ")}]`,
          );
        }
        if (field.description) {
          parts.push(`description: ${JSON.stringify(field.description)}`);
        }
        const body = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
        lines.push(`        ${quoteKey(field.name)}: ${body},`);
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

export function toMongoose(nodes: GenNode[], edges: GenEdge[]): string {
  // embed ไม่ใช่ foreign key — ไม่ gen ref (ตรงกับ toMongosh)
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"));
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
      const baseType =
        field.type === "Array" && field.of !== undefined
          ? `[${MONGOOSE_TYPES[field.of]}]`
          : MONGOOSE_TYPES[field.type];
      const ref = field.type === "ObjectId" ? refs.get(refKey(node.id, field.id)) : undefined;
      const enumVals = activeEnum(field);
      let value = baseType;
      if (
        ref !== undefined ||
        field.required ||
        enumVals !== undefined ||
        field.default !== undefined ||
        field.unique
      ) {
        const opts = [`type: ${baseType}`];
        if (ref !== undefined) opts.push(`ref: ${JSON.stringify(ref)}`);
        if (field.required) opts.push("required: true");
        if (enumVals) {
          opts.push(
            `enum: [${enumVals.map((v) => JSON.stringify(v)).join(", ")}]`,
          );
        }
        if (field.default !== undefined) {
          opts.push(
            `default: ${JSON.stringify(castDefault(field.type, field.default))}`,
          );
        }
        if (field.unique) opts.push("unique: true");
        value = `{ ${opts.join(", ")} }`;
      }
      lines.push(`  ${quoteKey(field.name)}: ${value},`);
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
        const enumVals = activeEnum(field);
        let tsType = TS_TYPES[field.type];
        if (field.type === "Array" && field.of !== undefined) {
          tsType = `${TS_TYPES[field.of]}[]`;
        }
        if (enumVals) {
          tsType = enumVals.map((v) => JSON.stringify(v)).join(" | ");
        }
        lines.push(`  ${quoteKey(field.name)}${optional}: ${tsType};`);
      }
      lines.push("}");
      return lines.join("\n");
    })
    .join("\n\n");
}

export function toMarkdown(nodes: GenNode[], edges: GenEdge[]): string {
  // embed ไม่ใช่ foreign key — ไม่แสดงในคอลัมน์อ้างอิง (ตรงกับ toMongosh/toMongoose)
  const refs = buildRefMap(nodes, edges.filter((e) => e.data?.kind !== "embed"));
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
      for (const field of node.data.fields) {
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
          mdEscape(field.name),
          typeCell,
          field.required ? "✓" : "",
          mdEscape(refs.get(refKey(node.id, field.id)) ?? ""),
          mdEscape(desc),
        ];
        lines.push(`| ${cells.join(" | ")} |`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function toSampleDoc(node: GenNode): string {
  const doc: Record<string, unknown> = {};
  // dedupe เหมือน codegen — กันตัวซ้ำทีหลังทับค่าตัวจริงเงียบๆ
  for (const field of dedupeFields(node.data.fields).fields) {
    const enumVals = activeEnum(field);
    if (field.type === "Array" && field.of !== undefined) {
      doc[field.name] = [SAMPLE_VALUES[field.of]];
    } else if (enumVals) {
      doc[field.name] = enumVals[0];
    } else if (field.default !== undefined) {
      doc[field.name] = castDefault(field.type, field.default);
    } else {
      doc[field.name] = SAMPLE_VALUES[field.type];
    }
  }
  return JSON.stringify(doc, null, 2);
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
}
