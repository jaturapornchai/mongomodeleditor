import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compositeRelationGroups,
  compositeRenderGroups,
  indexInputRows,
  persistedFlowDiagram,
} from "../app/diagram";
import { createServer } from "../app/mcp/server";
import {
  demo,
  lintProject,
  toMarkdown,
  toMongoose,
  toMongosh,
  toTypeScript,
  toWiki,
  type GenEdge,
  type GenNode,
} from "../app/schema";

test("schema codegen emits explicit compound indexes", () => {
  demo();

  const nodes: GenNode[] = [
    {
      id: "orders",
      data: {
        label: "orders",
        description: "รายการสั่งซื้อ",
        fields: [
          {
            id: "holding",
            name: "holdingcode",
            type: "String",
            required: true,
            description: "รหัสกลุ่มบริษัท",
          },
          {
            id: "created",
            name: "createdat",
            type: "Date",
            required: true,
            description: "วันที่สร้างรายการ",
          },
          {
            id: "meta",
            name: "meta",
            type: "Object",
            required: false,
            description: "ข้อมูลประกอบ",
            children: [
              {
                id: "meta-code",
                name: "code",
                type: "String",
                required: true,
                unique: true,
                description: "รหัสข้อมูลประกอบ",
              },
            ],
          },
        ],
        indexes: [
          {
            id: "ix-holding-created",
            fields: [
              { field: "holding", direction: 1 },
              { field: "created", direction: -1 },
            ],
            unique: true,
            sparse: true,
          },
          {
            id: "ix-duplicate-nested-unique",
            fields: [{ field: "meta-code", direction: 1 }],
          },
        ],
      },
    },
  ];

  assert.ok(
    toMongosh(nodes, []).includes(
      'db.orders.createIndex({ "holdingcode": 1, "createdat": -1 }, { unique: true, sparse: true });',
    ),
  );
  assert.ok(
    toMongoose(nodes, []).includes(
      'ordersSchema.index({ "holdingcode": 1, "createdat": -1 }, { unique: true, sparse: true });',
    ),
  );
  assert.equal(toMongoose(nodes, []).includes('ordersSchema.index({ "meta.code": 1 }'), false);
  assert.ok(toMarkdown(nodes, []).includes("| holdingcode ↑ + createdat ↓ | ✓ | ✓ |"));
  assert.equal(toMarkdown(nodes, []).includes("| meta.code ↑ |"), false);
  assert.ok(
    toWiki(nodes, [], "Demo")["collections/orders.md"].includes(
      "| holdingcode ↑ + createdat ↓ | ✓ | ✓ |",
    ),
  );
  assert.equal(toWiki(nodes, [], "Demo")["collections/orders.md"].includes("| meta.code ↑ |"), false);

  const invalidNodes = structuredClone(nodes);
  invalidNodes[0].data.fields.push(
    { id: "tags", name: "tags", type: "Array", of: "String", required: false, description: "ป้ายกำกับ" },
    { id: "labels", name: "labels", type: "Array", of: "String", required: false, description: "ฉลาก" },
    { id: "optional", name: "optionalcode", type: "String", required: false, description: "รหัสที่ไม่บังคับ" },
  );
  invalidNodes[0].data.indexes = [
    { id: "empty", fields: [] },
    { id: "bad-direction", fields: [{ field: "holding", direction: 0 as 1 }] },
    { id: "missing", fields: [{ field: "does-not-exist", direction: 1 }] },
    { id: "duplicate-member", fields: [{ field: "holding", direction: 1 }, { field: "holding", direction: -1 }] },
    { id: "duplicate-id", fields: [{ field: "holding", direction: 1 }] },
    { id: "duplicate-id", fields: [{ field: "created", direction: 1 }] },
    { id: "parallel-arrays", fields: [{ field: "tags", direction: 1 }, { field: "labels", direction: 1 }] },
    { id: "sparse-optional", fields: [{ field: "holding", direction: 1 }, { field: "optional", direction: 1 }], unique: true, sparse: true },
  ];
  assert.equal(toMongosh(invalidNodes, []).includes("createIndex({  })"), false);
  assert.equal(toMongosh(invalidNodes, []).includes('"holdingcode": 0'), false);
  assert.equal(toMongosh(invalidNodes, []).includes('"does-not-exist"'), false);
  assert.equal(toMongosh(invalidNodes, []).includes('"tags": 1, "labels": 1'), false);
  const invalidRules = new Set(
    lintProject([{ id: "d", name: "ผัง", nodes: invalidNodes, edges: [] }]).map((issue) => issue.rule),
  );
  assert.ok(invalidRules.has("index-empty"));
  assert.ok(invalidRules.has("index-direction"));
  assert.ok(invalidRules.has("index-field-not-found"));
  assert.ok(invalidRules.has("index-duplicate-field"));
  assert.ok(invalidRules.has("index-id-duplicate"));
  assert.ok(invalidRules.has("compound-index-parallel-arrays"));
  assert.ok(invalidRules.has("unique-index-member-not-required"));
});

test("MCP index boundary returns machine-coded validation errors", () => {
  const server = createServer() as unknown as {
    _registeredTools: Record<string, { inputSchema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } } }>;
  };
  const schema = server._registeredTools.update_collection.inputSchema;
  const invalid = schema.safeParse({
    project: "Demo",
    collection: "orders",
    indexes: [{ fields: [{ field: "", direction: 0 }] }],
  });
  assert.equal(invalid.success, false);
  const message = JSON.stringify(invalid.error);
  assert.match(message, /\[INDEX_FIELD_EMPTY\]/);
  assert.match(message, /\[INDEX_DIRECTION_INVALID\]/);

  const tooWide = schema.safeParse({
    project: "Demo",
    collection: "orders",
    indexes: [{ fields: Array.from({ length: 33 }, (_, i) => ({ field: `f${i}`, direction: 1 })) }],
  });
  assert.equal(tooWide.success, false);
  assert.match(JSON.stringify(tooWide.error), /\[TOO_MANY_INDEX_FIELDS\]/);
});

test("project lint resolves cross-tab relations and reports the owning diagram", () => {
  const child: GenNode = {
    id: "branch",
    data: {
      label: "branch",
      description: "สาขา",
      fields: [
        {
          id: "branch-holding",
          name: "holdingcode",
          type: "String",
          required: true,
          description: "รหัสกลุ่มบริษัทของสาขา",
        },
      ],
    },
  };
  const parent: GenNode = {
    id: "holding",
    data: {
      label: "holding",
      description: "กลุ่มบริษัท",
      fields: [
        {
          id: "holding-code",
          name: "holdingcode",
          type: "String",
          required: true,
          description: "รหัสกลุ่มบริษัท",
          key: true,
        },
        {
          id: "total-amount",
          name: "totalamount",
          type: "Number",
          required: true,
          description: "ยอดเงินรวม",
        },
      ],
    },
  };
  const relation: GenEdge = {
    source: "branch",
    sourceHandle: "branch-holding-s",
    target: "holding",
    targetHandle: "holding-code-t",
    data: { kind: "reference", cardinality: "1-n" },
  };

  const issues = lintProject([
    { id: "detail", name: "รายละเอียด", nodes: [child], edges: [relation] },
    { id: "master", name: "ข้อมูลหลัก", nodes: [parent], edges: [] },
  ]);

  assert.equal(issues.some((issue) => issue.rule === "dangling-relation"), false);
  assert.ok(
    issues.some(
      (issue) =>
        issue.rule === "money-not-decimal" &&
        issue.diagramId === "master" &&
        issue.diagram === "ข้อมูลหลัก" &&
      issue.field === "totalamount",
    ),
  );

});

test("nested relations survive lint and every code generator", () => {
  const child: GenNode = {
    id: "branch",
    data: {
      label: "branch",
      description: "สาขา",
      fields: [
        {
          id: "details",
          name: "details",
          type: "Object",
          required: true,
          description: "รายละเอียดสาขา",
          children: [
            {
              id: "holding-ref",
              name: "holdingref",
              type: "ObjectId",
              required: true,
              description: "รหัสอ้างอิงกลุ่มบริษัท",
            },
          ],
        },
      ],
    },
  };
  const parent: GenNode = {
    id: "holding",
    data: {
      label: "holding",
      description: "กลุ่มบริษัท",
      fields: [
        {
          id: "holding-external",
          name: "externalid",
          type: "ObjectId",
          required: true,
          key: true,
          description: "รหัสธุรกิจกลุ่มบริษัท",
        },
      ],
    },
  };
  const relation: GenEdge = {
    source: "branch",
    sourceHandle: "holding-ref-s",
    target: "holding",
    targetHandle: "holding-external-t",
    data: { kind: "reference", cardinality: "1-n" },
  };
  const nodes = [child, parent];

  assert.equal(
    lintProject([{ id: "d", name: "ผัง", nodes, edges: [relation] }]).some(
      (issue) => issue.rule === "dangling-relation",
    ),
    false,
  );
  assert.ok(toMongosh(nodes, [relation]).includes('createIndex({ "details.holdingref": 1 })'));
  assert.ok(toMongoose(nodes, [relation]).includes('ref: "holding"'));
  assert.ok(toTypeScript(nodes, [relation]).includes("→ อ้างอิงถึง holding"));
  assert.ok(
    toWiki(nodes, [relation], "Demo")["collections/branch.md"].includes("details.holdingref"),
  );
});

test("composite relations form one logical group and remove every field mapping", () => {
  const nodes: GenNode[] = [
    {
      id: "branch",
      data: {
        label: "branch",
        fields: [
          { id: "bh", name: "holdingcode", type: "String", required: true, keygroup: "branch-key" },
          { id: "bc", name: "companycode", type: "String", required: true, keygroup: "branch-key" },
        ],
      },
    },
    {
      id: "company",
      data: {
        label: "company",
        fields: [
          { id: "ch", name: "holdingcode", type: "String", required: true, keygroup: "company-key" },
          { id: "cc", name: "companycode", type: "String", required: true, keygroup: "company-key" },
        ],
      },
    },
  ];
  const edges: (GenEdge & { id: string })[] = [
    {
      id: "edge-holding",
      source: "branch",
      sourceHandle: "bh-s",
      target: "company",
      targetHandle: "ch-t",
      data: { kind: "reference", cardinality: "1-n" },
    },
    {
      id: "edge-company",
      source: "branch",
      sourceHandle: "bc-s",
      target: "company",
      targetHandle: "cc-t",
      data: { kind: "reference", cardinality: "1-n" },
    },
    {
      id: "edge-other-semantics",
      source: "branch",
      sourceHandle: "bc-s",
      target: "company",
      targetHandle: "cc-t",
      data: { kind: "embed", cardinality: "1-n" },
    },
  ];

  const groups = compositeRelationGroups(nodes, edges);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].map((edge) => edge.id),
    ["edge-holding", "edge-company"],
  );

  edges.push({
    id: "composite:edge-holding",
    source: "branch",
    sourceHandle: "bh-s",
    target: "company",
    targetHandle: "cc-t",
    data: { kind: "embed", cardinality: "1-1" },
  });
  const renderGroups = compositeRenderGroups(nodes, edges);
  assert.equal(renderGroups[0].id, "composite:edge-holding:2");
  assert.deepEqual(renderGroups[0].edges.map((edge) => edge.id), ["edge-holding", "edge-company"]);
});

test("persisted diagrams exclude transient React Flow state", () => {
  const persisted = persistedFlowDiagram(
    [{ id: "n", selected: true, dragging: true, measured: { width: 100 }, resizing: true, data: {} }],
    [{ id: "e", selected: true, label: "derived" }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(persisted)), {
    nodes: [{ id: "n", data: {} }],
    edges: [{ id: "e" }],
  });
});

test("index editor accepts comma separators without breaking exact field names", () => {
  const exact = new Set(["field,with,comma:1"]);
  assert.deepEqual(indexInputRows("name:1, address:-1", (value) => exact.has(value)), [
    "name:1",
    "address:-1",
  ]);
  assert.deepEqual(indexInputRows("field,with,comma:1", (value) => exact.has(value)), [
    "field,with,comma:1",
  ]);
});
