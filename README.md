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
- **คำอธิบายบังคับภาษาไทย** — popup คำอธิบาย (💬) validate ต้องมีอักขระไทย; จุดที่ยังขาดจะเป็น 💬 สีเหลืองเตือน (ทั้งฟิลด์และหัวคอลเลกชัน); กดเพิ่มฟิลด์แล้วเปิดช่องใส่คำอธิบายให้ทันที
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

### บันทึก/โหลด (ระบบโปรเจกต์ — ไม่ต้องเปิด folder)
- **หลายโปรเจกต์** — สร้าง/เปลี่ยนชื่อ/ลบ/เปิด ได้ในหน้าจอเดียว ทุกโปรเจกต์มีชื่อเสมอ
- ข้อมูลเก็บบน server (`data/projects.json`) เป็น source of truth — **auto save ทุก 400ms** + ตอนปิดหน้า
- **auto refresh** — AI (MCP) หรือแท็บอื่นแก้โปรเจกต์ จอจะดึงของใหม่มาแสดงเองภายใน 3 วิ พร้อม toast แจ้ง
- **หลาย diagram ต่อโปรเจกต์ = แท็บ** (สร้าง/สลับ/เปลี่ยนชื่อ/ลบ)
- **📥 นำเข้า** (เพิ่มเป็นแท็บใหม่) · **📤 ส่งออก** (diagram เดียว) · **💾 สำรองทั้งหมด** (ทุกแท็บไฟล์เดียว) · นำเข้าไฟล์เป็นโปรเจกต์ใหม่ได้ที่หน้าเลือกโปรเจกต์
- มีการเตือนเมื่อพื้นที่เต็ม / server เชื่อมไม่ได้ (มีโหมดออฟไลน์ localStorage)

### ศูนย์ส่งออกโค้ด (⚙️ สร้างโค้ด)
เปลี่ยน diagram เป็นโค้ดใช้งานจริงได้ 7 รูปแบบ (มีปุ่มคัดลอก):

| รูปแบบ | ได้อะไร |
|---|---|
| **mongosh** | `db.createCollection` + `$jsonSchema` validator + `createIndex` (unique/FK) |
| **Mongoose** | `Schema` พร้อม `ref`, `enum`, `default`, `unique`, `required` |
| **TypeScript** | `interface` ต่อคอลเลกชัน (enum → union type, Array → `T[]`) |
| **Markdown** | ตาราง data dictionary ภาษาไทย |
| **Wiki** | ชุดไฟล์ `.md` โครงสร้าง wikillm (Obsidian): `Home.md` + `collections/` + `types/` พร้อม `[[wikilink]]` และ mermaid graph — มีปุ่ม **🌐 แสดงแบบ Obsidian** เปิดหน้า wiki สวยๆ ในแอปได้ทันที |

### 🌐 หน้า Wiki แบบ Obsidian (overlay ในหน้าเดียวกัน)

กด **🌐** ที่การ์ดโปรเจกต์หรือในแท็บ Wiki → เปิด viewer ทับหน้าเดิมทันที (ไม่เปิดแท็บใหม่ — ปิด ✕ แล้วกลับมาทำงานต่อ state เดิม) เขียนเองทั้งหมด ไม่พึ่ง library ภายนอก:

- **Explorer** ซ้าย: โฟลเดอร์ Home / collections / types พับ-กางได้
- **Note**: properties (frontmatter) + ตารางฟิลด์ + `[[wikilink]]` กดข้าม note ได้จริง
- **🕸 กราฟ** interactive: collection/type/ความสัมพันธ์ จัดผังอัตโนมัติ คลิก node = เปิด note
- **🔗 ลิงก์**: backlinks (ใครเชื่อมมาหา) + ลิงก์ออก
- **Ctrl+K**: quick switcher ค้นหา note กระโดดไปได้ทันที
- รองรับภาษาไทยเต็มรูปแบบ (ชื่อโปรเจกต์/collection/field/note)
- มี route `/wiki/<ชื่อโปรเจกต์>` สำหรับเปิดตรง/แชร์ลิงก์ และ API `GET /api/wiki/<ชื่อโปรเจกต์>` คืนข้อมูล viewer (JSON)
| **ตัวอย่าง** | ตัวอย่าง JSON document ต่อคอลเลกชัน |
| **JSON** | โครงสร้าง diagram ดิบ |

### 🤖 MCP Server (ให้ AI ตัวอื่นเข้ามาทำงาน)

แอปมี MCP server ในตัวที่ **`http://localhost:3100/mcp`** (Streamable HTTP) — AI อื่น (Claude Desktop, Cursor, Kimi CLI ฯลฯ) เชื่อมเข้ามา **อ่าน / เพิ่ม / ลบ / แก้ไข** diagram ได้ครบทุกอย่าง และสั่งสร้างโค้ดได้ทุกรูปแบบ

ข้อมูลทั้งหมดเก็บที่ **`data/projects.json`** เป็น source of truth กลาง — **auto save ทุกการเปลี่ยนแปลง** ทั้งจาก UI (หน่วง 400ms) และจาก AI (ทันที) ส่วน `localStorage` ยังทำหน้าที่เป็น offline cache เผื่อ server ไม่ได้รัน

**ทุก tool ต้องระบุ `project` (ชื่อโปรเจกต์) เสมอ** — AI หลายตัว/หลายโปรเจกต์ทำงานพร้อมกันได้ โดยไม่ชนกัน

**ตั้งค่า client** (Claude Desktop / Cursor / Kimi CLI):

```json
{
  "mcpServers": {
    "mongomodel": { "url": "http://localhost:3100/mcp" }
  }
}
```

> client ที่รองรับเฉพาะ stdio ใช้ [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) เป็นสะพาน: `"command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3100/mcp"]`

**Tools ทั้งหมด:**

| กลุ่ม | Tools |
|---|---|
| project | `list_projects` · `create_project` · `rename_project` · `delete_project` |
| อ่าน | `list_diagrams` · `get_diagram` · `check_descriptions` (รายงานตัวที่ยังไม่มีคำอธิบายไทย) |
| diagram | `create_diagram` · `rename_diagram` · `delete_diagram` · `switch_diagram` |
| collection | `add_collection` · `update_collection` · `delete_collection` |
| field | `add_field` · `update_field` · `delete_field` (รองรับ nested ด้วย `parent`/`children` และ dotted path เช่น `address.geo.lat`) |
| relation | `add_relation` (reference/embed × cardinality) · `delete_relation` |
| codegen | `generate_code` — mongosh / mongoose / typescript / markdown / sample / json / **wiki** (wikillm) |

**บังคับคำอธิบายภาษาไทยเสมอ** — ทุก collection/field ที่สร้างหรือแก้ผ่าน MCP ต้องมี `description` ภาษาไทย (เช็กอักขระไทยจริง) ไม่มี/เป็นอังกฤษ = error พร้อมบอกจุด · เรียก `check_descriptions` เพื่อดูของเก่าที่ยังขาดแล้วเติมให้ครบ · ฝั่ง UI ก็บังคับเหมือนกัน: popup คำอธิบาย validate ไทย + จุดที่ขาดมี 💬 สีเหลืองเตือน

- AI แก้ปุ๊บเขียนลง `data/projects.json` ทันที — **UI ที่เปิดอยู่ auto refresh ให้เอง**ภายใน 3 วิ พร้อม toast แจ้ง
- ไม่มี auth — ใช้ในเครื่องเท่านั้น (เหมือน dev server ทั่วไป)
- ถ้าเปิด UI ครั้งแรกแล้ว server ว่าง ระบบจะ **migrate** งานจาก localStorage ขึ้นเป็นโปรเจกต์ `default` ให้อัตโนมัติ

---

## 🚀 เริ่มใช้งาน

### แบบ Docker (แนะนำ — รันค้างใน Docker Desktop MCP พร้อมใช้ตลอด)

**ต้องมี:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
# build + รันค้างหลังบ้าน (เปิด Docker Desktop ไว้)
npm run docker:up

# ดู log
npm run docker:logs

# ปิด
npm run docker:down
```

- UI → **http://localhost:3100** · MCP → **http://localhost:3100/mcp**
- ข้อมูลทุกโปรเจกต์อยู่ที่ `./data/projects.json` บนเครื่อง (mount เข้า container) — ลบ/สร้าง container ใหม่ข้อมูลไม่หาย
- `restart: unless-stopped` — เปิด Docker Desktop เมื่อไหร่ก็ขึ้นเอง

### แบบ Node.js (พัฒนา)

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

> พอร์ต 3100 ตั้งไว้ใน `package.json` (`next dev -p 3100`) และ `docker-compose.yml` เปลี่ยนได้ตามสะดวก

---

## 📁 โครงสร้างโปรเจกต์

```
mongomodeleditor/
├── app/
│   ├── page.tsx        # หัวใจของแอป — หน้าเลือกโปรเจกต์ (ProjectHome) + canvas/node/toolbar (Designer)
│   ├── schema.ts       # โมดูล codegen ล้วน (pure functions) + type กลาง — ไม่พึ่ง React
│   ├── store.ts        # server store หลาย project — source of truth (data/projects.json) แชร์โดย UI + MCP
│   ├── wiki-data.ts    # เตรียมข้อมูล wiki: รวม diagrams + โมเดลกราฟ
│   ├── wiki/[project]/ # หน้า wiki viewer แบบ Obsidian (explorer, note, กราฟ, backlinks, Ctrl+K)
│   ├── api/projects/   # REST CRUD โปรเจกต์ให้ UI (GET/POST/PATCH/PUT/DELETE)
│   ├── api/wiki/       # REST ข้อมูล wiki viewer (JSON)
│   ├── mcp/            # MCP server (Streamable HTTP) สำหรับ AI ภายนอก
│   ├── layout.tsx      # root layout + ฟอนต์ไทย (Noto Sans Thai)
│   ├── globals.css     # ธีม + tweak React Flow
│   └── error.tsx       # error boundary กันจอขาว
├── data/projects.json  # ข้อมูลทุกโปรเจกต์ (สร้างอัตโนมัติ, git-ignored, mount เข้า container)
├── Dockerfile          # production image (Next.js standalone, multi-stage)
├── docker-compose.yml  # รันค้างใน Docker Desktop (พอร์ต 3100, mount ./data)
├── erp-example.json    # ตัวอย่างโปรเจกต์ ERP 5 โมดูล (นำเข้าจากหน้าเลือกโปรเจกต์)
├── docs/preview.png    # ภาพตัวอย่าง
└── package.json
```

**หลักการแยกส่วน:** `schema.ts` เป็น logic ล้วน (แปลง data → โค้ด) ทดสอบแยกได้ไม่ต้องมี UI · `page.tsx` เป็น UI ทั้งหมด import codegen จาก `schema.ts` · `store.ts` เก็บข้อมูลฝั่ง server ชุดเดียวให้ทั้ง UI (`api/projects`) และ AI (`mcp`)

---

## 📖 วิธีใช้งาน

1. **สร้าง/เลือกโปรเจกต์** จากหน้าแรก (หรือ 📥 นำเข้าไฟล์เดิม)
2. กด **＋ เพิ่มคอลเลกชัน** → ได้กล่องใหม่ ดับเบิลคลิกที่หัวเพื่อตั้งชื่อ
3. กด **＋ เพิ่มฟิลด์** ในกล่อง → พิมพ์ชื่อ เลือกชนิด ตั้ง required/unique/enum
4. **เชื่อมความสัมพันธ์:** ลากจากจุดกลมขวาของฟิลด์ (เช่น `user_id`) ไปปล่อยที่คอลเลกชันเป้าหมาย
5. **ดับเบิลคลิกที่เส้น** เพื่อสลับ reference/embed และ cardinality
6. กด **▦ จัดผัง** ให้เรียงสวยอัตโนมัติ
7. กด **⚙️ สร้างโค้ด** → เลือกแท็บ mongosh/Mongoose/TypeScript/Wiki → **คัดลอก** ไปใช้
8. งานบันทึกเองอัตโนมัติ — AI แก้ผ่าน MCP เมื่อไหร่ จอจะ **auto refresh** ให้เอง

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

**วิธีเปิด:** หน้าเลือกโปรเจกต์ → กด **📥 นำเข้า** แล้วเลือกไฟล์ `erp-example.json` — ได้โปรเจกต์ใหม่ชื่อ "erp-example"

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
| Generator ทั้งหมด | `schema.ts` (`toMongosh`, `toMongoose`, `toWiki`, …) |
| Self-check ของ codegen | `schema.ts` → `demo()` (รันตอน dev, throw ถ้าพัง) |
| หน้าเลือก/จัดการโปรเจกต์ | `page.tsx` → `ProjectHome` |
| กล่องคอลเลกชัน (node UI) | `page.tsx` → `CollectionNodeView` |
| Canvas + toolbar + save/load | `page.tsx` → `Designer` |
| หน้า wiki แบบ Obsidian | `wiki/[project]/` (`WikiViewer` + `note.tsx` parser/renderer + `graph.tsx` กราฟ) |
| เตรียมข้อมูล wiki (merge + กราฟ) | `wiki-data.ts` → `getWikiData()` |
| Server store หลาย project (source of truth + rev) | `store.ts` → `data/projects.json` |
| REST CRUD โปรเจกต์ให้ UI | `app/api/projects/route.ts`, `app/api/projects/[name]/route.ts` |
| MCP tools ทั้งหมด | `app/mcp/route.ts` (เพิ่ม tool = `server.registerTool` ใน `createServer()`) |
| Key ใน localStorage | `mongomodel:index` (รายการแท็บ), `mongomodel:d:<id>` (แต่ละ diagram) — เป็น offline cache ของ server |

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
- ข้อมูลเก็บที่ `data/projects.json` บนเครื่องที่รัน server (`localStorage` เป็นแค่ cache เผื่อออฟไลน์) — ย้ายเครื่องต้องก๊อปไฟล์นี้ไปด้วย หรือ **💾 สำรอง** เก็บไฟล์ไว้
- การแก้ชนกัน (UI กับ AI แก้พร้อมกัน) เป็นแบบ last-write-wins — ฝั่ง UI จะ auto refresh ตามของใหม่บน server เสมอ
- ยังไม่รองรับ nested document แบบซ้อนหลายชั้น (ใช้ `Array<Object>` แทนได้)

---

## 📄 License

MIT — นำไปใช้/ดัดแปลง/ต่อยอดได้อิสระ

---

<sub>สร้างด้วย 🤖 [Claude Code](https://claude.com/claude-code) (Opus 4.8 · Fable · Sonnet)</sub>
