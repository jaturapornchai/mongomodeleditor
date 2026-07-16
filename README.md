# MongoModel — เครื่องมือออกแบบ Data Model ของ MongoDB

**ออกแบบโครงสร้างข้อมูล MongoDB บน canvas แบบลากวาง** — เชื่อมความสัมพันธ์ระหว่างคอลเลกชัน, ใส่รายละเอียดฟิลด์, แล้ว **ส่งออกเป็นโค้ดใช้งานจริง** (mongosh / Mongoose / TypeScript) ได้ทันที ธีมมืดสไตล์ DataGrip เน้นภาษาไทย ทำงานในเบราว์เซอร์ล้วน **ไม่ต้องต่อฐานข้อมูลจริง**

![ภาพตัวอย่าง MongoModel](docs/preview.png)

---

## 🤖 โปรเจกต์นี้สร้างด้วย AI ทั้งหมด

โค้ดทุกบรรทัดในโปรเจกต์นี้เขียนโดย **[Claude Code](https://claude.com/claude-code)** (โมเดล **Claude Opus 4.8** เป็นผู้ควบคุม) ผ่านกระบวนการ **multi-agent orchestration**:

- 🧠 **Opus 4.8** — วางแผน ตัดสินใจ ควบคุมงาน และรีวิวโค้ด
- ⚡ **Fable** — ลงมือเขียนโค้ดส่วนที่ยาก (implementation, codegen, algorithm)
- 🔍 **Sonnet** — ทดสอบแบบ end-to-end ด้วย Playwright (UAT, regression)

ทุกฟีเจอร์ผ่านวงจร **ค้นหา → ออกแบบ → เขียน (ขนานหลาย agent) → ทดสอบจริงในเบราว์เซอร์ → แก้บั๊กวนจนผ่าน** โดยตรวจ `tsc` + `build` + Playwright ทุกครั้งก่อนถือว่าเสร็จ

> 💡 **เอาไปต่อยอดได้เลย** — โครงสร้างโค้ดแยกส่วนชัดเจน (ดูหัวข้อ [การพัฒนาต่อ](#-การพัฒนาต่อ-ต่อยอด)) เพิ่มชนิดข้อมูล เพิ่มรูปแบบ export หรือเพิ่มฟีเจอร์ canvas ได้ไม่ยาก fork ไปใช้/ดัดแปลงได้ตามสะดวก

---

## ✨ ฟีเจอร์

### คอลเลกชัน (Collection)
- ลากวาง node บน canvas, **ลากขอบขวาปรับความกว้างได้** (จำค่าถาวร)
- แก้ชื่อแบบ inline (ดับเบิลคลิกที่หัว), ทำซ้ำ (Ctrl+D / ปุ่ม ⧉), ลบ (มียืนยันถ้ามีฟิลด์)
- ใส่คำอธิบายคอลเลกชัน (แสดง inline ใต้หัว)
- **ปุ่ม ▦ จัดผัง** — เรียง node อัตโนมัติตามความสัมพันธ์ (master ซ้าย → transaction ขวา) ไม่ทับกัน

### ฟิลด์ (Field)
- 9 ชนิด: `String` `Number` `Boolean` `Date` `ObjectId` `Array` `Object` `Decimal128` `Mixed`
- `_id` เป็น Primary Key (🔑) อัตโนมัติ
- ตั้ง **required** (`*`), **unique index** (`U`), **enum** + **ค่าเริ่มต้น (default)** ผ่าน popup
- **Array มีชนิดสมาชิก** (`Array<String>`, `Array<Object>` ฯลฯ)
- ใส่คำอธิบายต่อฟิลด์ (แสดง inline)
- **จัดลำดับฟิลด์ด้วยการลากปล่อย** (จับที่ ⠿)
- ตรวจชื่อซ้ำ/ว่างอัตโนมัติ (ขอบแดงเตือน)

### เส้นเชื่อมความสัมพันธ์ (Relationship)
- ลากจากจุดขวาของฟิลด์ → ไปยังคอลเลกชันอื่น
- **ดับเบิลคลิกเส้น** เพื่อวนชนิด: `reference`/`embed` × cardinality `1:1` / `1:N` / `N:N` (embed = เส้นประ)
- ป้ายกำกับเส้นตามชื่อฟิลด์ + cardinality (อัปเดตตามการ rename)
- hover node → เส้นที่เกี่ยวข้องสว่างขึ้น เส้นอื่นจางลง
- ลากเส้นซ้ำจากฟิลด์เดิม = ย้ายปลายทาง (1 ฟิลด์ = 1 อ้างอิง)

### บันทึก/โหลด (ในเครื่อง — ไม่ต้องมี server)
- บันทึกอัตโนมัติลง `localStorage` ทุก 400ms + ตอนปิดหน้า
- **หลาย diagram = แท็บ** (สร้าง/สลับ/เปลี่ยนชื่อ/ลบ)
- **📥 นำเข้า** (เพิ่มเป็นแท็บใหม่) · **📤 ส่งออก** (diagram เดียว) · **💾 สำรองทั้งหมด** (ทุกแท็บไฟล์เดียว) · **📂 เปิดโปรเจกต์** (ล้างแล้วโหลดใหม่ทั้งหมด)
- มีการเตือนเมื่อพื้นที่เต็ม / เปิดซ้อนหลายแท็บเบราว์เซอร์ (กันข้อมูลหายเงียบ)

### ศูนย์ส่งออกโค้ด (⚙️ สร้างโค้ด)
เปลี่ยน diagram เป็นโค้ดใช้งานจริงได้ 6 รูปแบบ (มีปุ่มคัดลอก):

| รูปแบบ | ได้อะไร |
|---|---|
| **mongosh** | `db.createCollection` + `$jsonSchema` validator + `createIndex` (unique/FK) |
| **Mongoose** | `Schema` พร้อม `ref`, `enum`, `default`, `unique`, `required` |
| **TypeScript** | `interface` ต่อคอลเลกชัน (enum → union type, Array → `T[]`) |
| **Markdown** | ตาราง data dictionary ภาษาไทย |
| **ตัวอย่าง** | ตัวอย่าง JSON document ต่อคอลเลกชัน |
| **JSON** | โครงสร้าง diagram ดิบ |

---

## 🚀 เริ่มใช้งาน

**ต้องมี:** [Node.js](https://nodejs.org/) 20 ขึ้นไป

```bash
# 1) โคลนโปรเจกต์
git clone https://github.com/jaturapornchai/mongomodeleditor.git
cd mongomodeleditor

# 2) ติดตั้ง dependency
npm install

# 3) รัน dev server
npm run dev
```

เปิดเบราว์เซอร์ที่ **http://localhost:3100**

```bash
# build โปรดักชัน
npm run build && npm start
```

> พอร์ต 3100 ตั้งไว้ใน `package.json` (`next dev -p 3100`) เปลี่ยนได้ตามสะดวก

---

## 📁 โครงสร้างโปรเจกต์

```
mongomodeleditor/
├── app/
│   ├── page.tsx        # หัวใจของแอป — canvas, node, toolbar, save/load (client component)
│   ├── schema.ts       # โมดูล codegen ล้วน (pure functions) + type กลาง — ไม่พึ่ง React
│   ├── layout.tsx      # root layout + ฟอนต์ไทย (Noto Sans Thai)
│   ├── globals.css     # ธีม + tweak React Flow
│   └── error.tsx       # error boundary กันจอขาว
├── erp-example.json    # ตัวอย่างโปรเจกต์ ERP 5 โมดูล (โหลดผ่าน "เปิดโปรเจกต์")
├── docs/preview.png    # ภาพตัวอย่าง
└── package.json
```

**หลักการแยกส่วน:** `schema.ts` เป็น logic ล้วน (แปลง data → โค้ด) ทดสอบแยกได้ไม่ต้องมี UI · `page.tsx` เป็น UI ทั้งหมด import codegen จาก `schema.ts`

---

## 📖 วิธีใช้งาน

1. กด **＋ เพิ่มคอลเลกชัน** → ได้กล่องใหม่ ดับเบิลคลิกที่หัวเพื่อตั้งชื่อ
2. กด **＋ เพิ่มฟิลด์** ในกล่อง → พิมพ์ชื่อ เลือกชนิด ตั้ง required/unique/enum
3. **เชื่อมความสัมพันธ์:** ลากจากจุดกลมขวาของฟิลด์ (เช่น `user_id`) ไปปล่อยที่คอลเลกชันเป้าหมาย
4. **ดับเบิลคลิกที่เส้น** เพื่อสลับ reference/embed และ cardinality
5. กด **▦ จัดผัง** ให้เรียงสวยอัตโนมัติ
6. กด **⚙️ สร้างโค้ด** → เลือกแท็บ mongosh/Mongoose/TypeScript → **คัดลอก** ไปใช้
7. งานบันทึกเองอัตโนมัติ — อยากพกพา/สำรองกด **💾 สำรองทั้งหมด**

**คีย์ลัด:** `Ctrl+D` ทำซ้ำคอลเลกชัน · `Ctrl+K` ค้นหา · `Delete` ลบสิ่งที่เลือก · ลากพื้นว่าง = เลือกหลายอัน

---

## 💾 รูปแบบไฟล์ (สำหรับต่อยอด / สร้าง diagram ด้วยสคริปต์)

ไฟล์ที่ import/export เป็น JSON 2 แบบ:

**แบบ diagram เดียว** (จาก 📤 ส่งออก)
```jsonc
{
  "app": "mongomodel",
  "version": 1,
  "name": "ชื่อ diagram",
  "nodes": [ /* … */ ],
  "edges": [ /* … */ ]
}
```

**แบบสำรองทั้งชุด** (จาก 💾 สำรองทั้งหมด — โหลดด้วย 📂 เปิดโปรเจกต์)
```jsonc
{
  "app": "mongomodel",
  "version": 2,
  "diagrams": [
    { "name": "โมดูล 1", "nodes": [ /* … */ ], "edges": [ /* … */ ] }
  ]
}
```

**โครงสร้าง node (คอลเลกชัน):**
```jsonc
{
  "id": "customers",
  "type": "collection",
  "position": { "x": 60, "y": 60 },
  "width": 300,
  "data": {
    "label": "customers",
    "description": "ลูกค้า",
    "fields": [
      { "id": "customers__code", "name": "code", "type": "String",
        "required": true, "unique": true, "description": "รหัสลูกค้า" },
      { "id": "customers__type", "name": "type", "type": "String",
        "enum": ["individual", "company"], "default": "company" },
      { "id": "customers__addresses", "name": "addresses",
        "type": "Array", "of": "Object", "description": "ที่อยู่ (ฝัง)" }
    ]
  }
}
```

**โครงสร้าง edge (ความสัมพันธ์):** `sourceHandle` = `"<fieldId>-s"`, `targetHandle` = `"ref"`
```jsonc
{
  "id": "e1",
  "source": "sales_orders",
  "sourceHandle": "sales_orders__customer_id-s",
  "target": "customers",
  "targetHandle": "ref",
  "data": { "kind": "reference", "cardinality": "1-n" }
}
```

---

## 🧩 ตัวอย่าง ERP

ไฟล์ [`erp-example.json`](erp-example.json) เป็นตัวอย่างระบบ ERP ครบ **5 โมดูล · 16 คอลเลกชัน · 116 ฟิลด์**:

| โมดูล | คอลเลกชัน |
|---|---|
| **ขาย & CRM** | customers · sales_orders · invoices · payments |
| **จัดซื้อ** | suppliers · purchase_orders · goods_receipts |
| **สินค้าคงคลัง** | categories · products · warehouses · stock_movements |
| **บัญชี** | chart_of_accounts · journal_entries · journal_lines |
| **บุคคล (HR)** | departments · employees |

ครอบทุกฟีเจอร์: Decimal128 (เงิน), embed vs reference, self-reference (โครงต้นไม้), enum, unique, Array\<Object\>

**วิธีเปิด:** กด **📂 เปิดโปรเจกต์** แล้วเลือกไฟล์ `erp-example.json`

---

## 🛠️ การพัฒนาต่อ (ต่อยอด)

โครงสร้างออกแบบให้ขยายง่าย — จุดที่แก้บ่อย:

### เพิ่มชนิดข้อมูลใหม่ (เช่น `UUID`)
แก้ที่ `app/schema.ts`:
1. เพิ่มใน `FIELD_TYPES`
2. เพิ่ม mapping ใน `BSON_TYPES`, `MONGOOSE_TYPES`, `TS_TYPES`, `SAMPLE_VALUES`

ทุก generator จะรองรับทันที ส่วน UI (`page.tsx`) วนจาก `FIELD_TYPES` อยู่แล้วจึงไม่ต้องแก้

### เพิ่มรูปแบบส่งออก (เช่น Zod / GraphQL)
1. เขียนฟังก์ชัน `toZod(nodes, edges): string` ใน `app/schema.ts` (ดู `toMongoose` เป็นแบบอย่าง)
2. เพิ่มชื่อใน `CODE_TABS` และ branch ใน `codeText` (`page.tsx`)

### เพิ่มคุณสมบัติฟิลด์ (เช่น `minLength`)
1. เพิ่มใน `type Field` (`schema.ts`)
2. อ่านค่าใน generator ที่ต้องการ
3. เพิ่ม UI ป้อนค่าใน `CollectionNodeView`

### จุดสำคัญในโค้ด
| ส่วน | อยู่ที่ |
|---|---|
| Type กลาง (`Field`, `CollectionData`, `EdgeRelData`) | `schema.ts` |
| Generator ทั้งหมด | `schema.ts` (`toMongosh`, `toMongoose`, …) |
| Self-check ของ codegen | `schema.ts` → `demo()` (รันตอน dev, throw ถ้าพัง) |
| กล่องคอลเลกชัน (node UI) | `page.tsx` → `CollectionNodeView` |
| Canvas + toolbar + save/load | `page.tsx` → `Designer` |
| Key ใน localStorage | `mongomodel:index` (รายการแท็บ), `mongomodel:d:<id>` (แต่ละ diagram) |

---

## 🧱 เทคโนโลยี

- [Next.js 16](https://nextjs.org/) (App Router, Turbopack)
- [React 19](https://react.dev/)
- [@xyflow/react](https://reactflow.dev/) (React Flow) — canvas + node + edge
- [Tailwind CSS v4](https://tailwindcss.com/)
- TypeScript (strict) — ไม่มี dependency สำหรับ codegen (pure functions)

---

## ⚠️ ข้อจำกัด

- เป็น **เครื่องมือออกแบบ** เท่านั้น — ไม่เชื่อมต่อ MongoDB จริง (ส่งออกเป็นโค้ดให้เอาไปรันเอง)
- ข้อมูลเก็บใน `localStorage` ของเบราว์เซอร์ — เปลี่ยนเครื่อง/ล้าง cache แล้วหาย ควร **💾 สำรอง** เก็บไฟล์ไว้
- ยังไม่มี undo/redo และยังไม่รองรับ nested document แบบซ้อนหลายชั้น (ใช้ `Array<Object>` แทนได้)

---

## 📄 License

MIT — นำไปใช้/ดัดแปลง/ต่อยอดได้อิสระ

---

<sub>สร้างด้วย 🤖 [Claude Code](https://claude.com/claude-code) (Opus 4.8 · Fable · Sonnet)</sub>
