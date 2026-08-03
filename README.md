# MongoModel — เครื่องมือออกแบบ Data Model ของ MongoDB

**ออกแบบโครงสร้างข้อมูล MongoDB บน canvas แบบลากวาง** — เชื่อมความสัมพันธ์ระหว่างคอลเลกชัน, ใส่รายละเอียดฟิลด์, แล้ว **ส่งออกเป็นโค้ดใช้งานจริง** (mongosh / Go / Mongoose / TypeScript) ได้ทันที ธีมมืดสไตล์ DataGrip เน้นภาษาไทย ทำงานในเบราว์เซอร์ล้วน **ไม่ต้องต่อฐานข้อมูลจริง**

![ภาพตัวอย่าง MongoModel](docs/preview.png)

---

## 🤖 โปรเจกต์นี้สร้างด้วย AI ทั้งหมด

โค้ดทุกบรรทัดในโปรเจกต์นี้เขียนโดย **[Claude Code](https://claude.com/claude-code)** ผ่านกระบวนการ **multi-agent orchestration** — Claude 3 โมเดลแบ่งหน้าที่กัน:

- 🧠 **Opus** — วางแผน แตกงาน มอบหมาย รีวิวผลทุกสาย และตัดสินใจขั้นสุดท้าย
- ⚡ **Fable** — ลงมือเขียนโค้ด (implementation, codegen, MCP, algorithm)
- 🔍 **Sonnet** — ทดสอบแบบ end-to-end ด้วย Playwright (UAT, regression)

ทุกฟีเจอร์ผ่านวงจร **ออกแบบ → เขียน (ขนานหลายสาย) → playtest จริงหลายสายพร้อมกัน (UI / MCP / wiki) → แก้บั๊กวนจนผ่าน** โดยตรวจ `tsc` + `build` + Playwright ทุกครั้งก่อนถือว่าเสร็จ

> 💡 **เอาไปต่อยอดได้เลย** — โครงสร้างโค้ดแยกส่วนชัดเจน (ดูหัวข้อ [การพัฒนาต่อ](#-การพัฒนาต่อ-ต่อยอด)) เพิ่มชนิดข้อมูล เพิ่มรูปแบบ export หรือเพิ่มฟีเจอร์ canvas ได้ไม่ยาก fork ไปใช้/ดัดแปลงได้ตามสะดวก

---

## ✨ ฟีเจอร์

### คอลเลกชัน (Collection)
- ลากวาง node บน canvas, **ลากขอบขวาปรับความกว้างได้** (จำค่าถาวร)
- แก้ชื่อแบบ inline (ดับเบิลคลิกที่หัว), ทำซ้ำ (Ctrl+D / ปุ่ม ⧉), ลบ (มียืนยันถ้ามีฟิลด์)
- ใส่คำอธิบายคอลเลกชัน (แสดง inline ใต้หัว)
- **แถบ key ใต้หัวการ์ด** — สรุป key ทั้งหมดของคอลเลกชัน (PK / 🔑 / ⛓ key ผสม) จุดลากเส้นของ key อยู่ที่แถบนี้ พร้อม badge `← N` บอกว่าถูกอ้างจากกี่คอลเลกชันในแท็บ
- **Indexes เพิ่มเติมระดับคอลเลกชัน** — กำหนด compound index ได้หลายชุด เลือกลำดับขึ้น/ลง, `unique` และ `sparse`; ใช้ dotted path กับฟิลด์ซ้อนได้
- **LOD เมื่อซูมออก** — การ์ดย่อเหลือ key, ฟิลด์ที่มีเส้นเชื่อม และยอดรวม ลดความรกของผังใหญ่โดยเส้นไม่หาย
- **ปุ่ม ▦ จัดผัง** — เรียง node อัตโนมัติตามความสัมพันธ์ (master ซ้าย → transaction ขวา) ไม่ทับกัน

### ฟิลด์ (Field)
- 9 ชนิด: `String` `Number` `Boolean` `Date` `ObjectId` `Array` `Object` `Decimal128` `Mixed`
- `_id` เป็น Primary Key (🔑) อัตโนมัติ
- ตั้ง **required** (`*`), **unique index** (`U`), **enum** + **ค่าเริ่มต้น (default)** ผ่าน popup
- ธง key เชิงออกแบบ: **🔑 business key** (ฟิลด์ที่คอลเลกชันอื่นใช้อ้าง) · **⛓ key ผสม** (`keygroup` — รวมหลายฟิลด์เป็น compound index เลือกโหมด **ห้ามซ้ำ/ซ้ำได้**) — ฟิลด์ที่เป็น key ถูก pin ขึ้นกลุ่มบนสุดของการ์ดเสมอ และ relation ระหว่าง key ผสมคู่เดียวกันแสดงเป็นเส้นสรุปเส้นเดียว
- **ฟิลด์ซ้อน (nested)** — `Object` / `Array<Object>` มีฟิลด์ย่อยได้หลายชั้น (พับ/ขยายได้)
- **คำอธิบายบังคับภาษาไทย** — popup คำอธิบาย (💬) validate ต้องมีอักขระไทย; จุดที่ยังขาดจะเป็น 💬 สีเหลืองเตือน (ทั้งฟิลด์และหัวคอลเลกชัน); กดเพิ่มฟิลด์แล้วเปิดช่องใส่คำอธิบายให้ทันที
- **Array มีชนิดสมาชิก** (`Array<String>`, `Array<Object>` ฯลฯ)
- ใส่คำอธิบายต่อฟิลด์ (แสดง inline)
- **จัดลำดับฟิลด์ด้วยการลากปล่อย** (จับที่ ⠿)
- ตรวจชื่อซ้ำ/ว่างอัตโนมัติ (ขอบแดงเตือน)

### เส้นเชื่อมความสัมพันธ์ (Relationship)
- relation เป็น **field→field เสมอ**: ลากจากจุดของฟิลด์ FK (ฝั่งลูก) ไปปล่อยที่**ฟิลด์ business key** ของคอลเลกชันเป้าหมาย — หัวลูกศรชี้ทิศ **แม่→ลูก**
- จุดเชื่อมมีทั้ง 2 ข้างของฟิลด์ — ตอน render เลือกข้างที่หันเข้าหากันให้อัตโนมัติ (ลาก node แล้วเส้นสลับข้างเอง ไม่อ้อมหลังการ์ด)
- **เชื่อมข้ามแท็บได้** — ปลายทางที่อยู่คนละแท็บแสดงเป็นการ์ดเสมือนเส้นประ (กดแล้วกระโดดไปแท็บนั้น)
- **ดับเบิลคลิกเส้น** เพื่อวนชนิด: `reference`/`embed` × cardinality `1:1` / `1:N` / `N:N` (embed = เส้นประ)
- เส้น key ผสมหลายคู่แสดงเป็นเส้นเดียว; คลิกหรือคลิกขวา **ดู mapping รายฟิลด์** ได้
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
เปลี่ยน diagram เป็นโค้ดใช้งานจริงได้ 8 รูปแบบ (มีปุ่มคัดลอก):

| รูปแบบ | ได้อะไร |
|---|---|
| **mongosh** | `db.createCollection` + `$jsonSchema` validator + `createIndex` (unique / FK / key ผสม / indexes ที่กำหนดเพิ่ม) |
| **Go** | `struct` ต่อคอลเลกชัน พร้อม tag `bson`/`json` (`primitive.ObjectID`, `primitive.Decimal128`, nested struct) |
| **Mongoose** | `Schema` พร้อม `ref`, `enum`, `default`, `unique`, `required` และ compound indexes |
| **TypeScript** | `interface` ต่อคอลเลกชัน (enum → union type, Array → `T[]`) |
| **Markdown** | ตาราง data dictionary ภาษาไทย |
| **Wiki** | ชุดไฟล์ `.md` โครงสร้าง wikillm (Obsidian): `Home.md` + `collections/` + `types/` พร้อม `[[wikilink]]` และ mermaid graph — มีปุ่ม **🌐 แสดงแบบ Obsidian** เปิดหน้า wiki สวยๆ ในแอปได้ทันที |
| **ตัวอย่าง** | ตัวอย่าง JSON document ต่อคอลเลกชัน |
| **JSON** | โครงสร้าง diagram ดิบ |

ปุ่ม **🩺 ตรวจ** ตรวจทุกแท็บในโปรเจกต์ครั้งเดียวและกดผลลัพธ์เพื่อข้ามไปคอลเลกชันในแท็บที่พบปัญหาได้; หน้าสร้างโค้ดยังคงเตือนเฉพาะแท็บที่กำลังส่งออก

### 🌐 หน้า Wiki แบบ Obsidian (overlay ในหน้าเดียวกัน)

กด **🌐** ที่การ์ดโปรเจกต์หรือในแท็บ Wiki → เปิด viewer ทับหน้าเดิมทันที (ไม่เปิดแท็บใหม่ — ปิด ✕ แล้วกลับมาทำงานต่อ state เดิม) เขียนเองทั้งหมด ไม่พึ่ง library ภายนอก:

- **Explorer** ซ้าย: โฟลเดอร์ Home / collections / types พับ-กางได้
- **Note**: properties (frontmatter) + ตารางฟิลด์ + `[[wikilink]]` กดข้าม note ได้จริง
- **🕸 กราฟ** interactive: collection/type/ความสัมพันธ์ จัดผังอัตโนมัติ คลิก node = เปิด note
- **🔗 ลิงก์**: backlinks (ใครเชื่อมมาหา) + ลิงก์ออก
- **Ctrl+K**: quick switcher ค้นหา note กระโดดไปได้ทันที
- รองรับภาษาไทยเต็มรูปแบบ (ชื่อโปรเจกต์/collection/field/note)
- มี route `/wiki/<ชื่อโปรเจกต์>` สำหรับเปิดตรง/แชร์ลิงก์ และ API `GET /api/wiki/<ชื่อโปรเจกต์>` คืนข้อมูล viewer (JSON)

### 🤖 MCP Server (ให้ AI ตัวอื่นเข้ามาทำงาน)

แอปมี MCP server ในตัว 2 transport (tools ชุดเดียวกัน **25 ตัว** นิยามใน `app/mcp/server.ts`) — AI อื่น (Claude Desktop, Cursor, Kimi CLI ฯลฯ) เชื่อมเข้ามา **อ่าน / เพิ่ม / ลบ / แก้ไข** diagram ได้ครบทุกอย่าง และสั่งสร้างโค้ดได้ทุกรูปแบบ · server ส่ง **instructions** (กฎโปรเจกต์ + workflow แนะนำ) ให้ client ตอน initialize — AI ภายนอกรู้กติกาโดยไม่ต้องอ่าน docs ก่อน

- **Streamable HTTP** — `http://localhost:3100/mcp` (ติดมากับเว็บแอป ต้องรัน dev/Docker ก่อน)
- **stdio** — client spawn process เองผ่าน `mcp-stdio.ts` (ไม่ต้องรันเว็บแอป; แตะ `data/projects.json` ก้อนเดียวกัน)

ข้อมูลทั้งหมดเก็บที่ **`data/projects.json`** เป็น source of truth กลาง — **auto save ทุกการเปลี่ยนแปลง** ทั้งจาก UI (หน่วง 400ms) และจาก AI (ทันที) ส่วน `localStorage` ยังทำหน้าที่เป็น offline cache เผื่อ server ไม่ได้รัน

**ทุก tool ต้องระบุ `project` (ชื่อโปรเจกต์) เสมอ** — AI หลายตัว/หลายโปรเจกต์ทำงานพร้อมกันได้ โดยไม่ชนกัน

**ตั้งค่า client** (Claude Desktop / Cursor / Kimi CLI) — แบบ HTTP:

```json
{
  "mcpServers": {
    "mongomodel": { "url": "http://localhost:3100/mcp" }
  }
}
```

แบบ **stdio** (client spawn process เอง — แก้ path ให้ตรงโฟลเดอร์โปรเจกต์; ต้อง `npm install` ไว้ก่อนเพราะใช้ `tsx` ของโปรเจกต์):

```json
{
  "mcpServers": {
    "mongomodel": {
      "command": "npm",
      "args": ["run", "--silent", "--prefix", "D:/mongomodel", "mcp:stdio"]
    }
  }
}
```

> ผ่าน `npm run` ต้องมี `--silent` เสมอ ไม่งั้น banner ของ npm ปนเข้าช่อง JSON-RPC · ใช้ `"command": "npx", "args": ["tsx", "D:/mongomodel/mcp-stdio.ts"]` ก็ได้ (script จะ chdir กลับมาที่โปรเจกต์เอง ไม่ขึ้นกับ cwd ของ client) · หรือจะใช้ [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) เป็นสะพานไป HTTP ก็ยังได้: `"command": "npx", "args": ["-y", "mcp-remote", "http://localhost:3100/mcp"]`

**Tools ทั้งหมด (25 ตัว):** ทุกตัวมี title ภาษาไทย + **annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint`) — MCP client ใช้ตัดสิน auto-approve ได้ (tool อ่านอย่างเดียวผ่านเลย tool ลบ/เขียนทับค่อยถามผู้ใช้)

| กลุ่ม | Tools |
|---|---|
| project | `list_projects` · `create_project` · `rename_project` · `delete_project` |
| snapshot | `list_revisions` · `restore_revision` — ระบบเก็บ snapshot อัตโนมัติก่อนเขียนทุกครั้ง (ล่าสุด 20 ไฟล์ใน `data/history/`) แก้พลาดย้อนกลับได้ |
| อ่าน/ตรวจ | `list_diagrams` · `get_diagram` (`detail: "summary"` = โครงย่อประหยัดโทเคน) · `check_descriptions` (รายงานตัวที่ยังไม่มีคำอธิบายไทย) · `lint_model` (ตรวจกฎออกแบบ เช่น ฟิลด์เงินเป็น Number, unique บนฟิลด์ไม่ required, FK ชนิดไม่ตรงปลายทาง, array ไม่มีขอบเขต) |
| diagram | `create_diagram` · `rename_diagram` · `delete_diagram` · `switch_diagram` · `replace_diagram` (bulk import ทั้งผัง — validate ทั้งหมดก่อนแล้วเขียน atomic) |
| collection | `add_collection` · `update_collection` (รวมการแทนที่ `indexes[]`) · `delete_collection` · `move_collection` (ย้ายข้ามแท็บ — เส้นเดิมกลายเป็นเส้นข้ามแท็บอัตโนมัติ) |
| field | `add_field` · `update_field` · `delete_field` (รองรับ nested ด้วย `parent`/`children` และ dotted path เช่น `address.geo.lat`) |
| relation | `add_relation` (field→field: บังคับ `targetfield` · reference/embed × cardinality) · `delete_relation` |
| codegen | `generate_code` — mongosh / go / mongoose / typescript / markdown / sample / json / **wiki** (wikillm) |

**กฎเสริมที่ caller ควรรู้:**
- **คำอธิบายภาษาไทยเสมอ** (อ่านรายละเอียดด้านล่าง)
- `add_collection` **ปฏิเสธ label ซ้ำ**ใน diagram เดียวกัน — ส่ง `replace: true` เพื่อแทนที่ (ลบเส้นเดิมด้วย)
- relation ต้องอ้าง **business key** ของฝั่งแม่ (เช่น `code`, `holdingcode`) — ห้ามอ้าง identity ภายในอย่าง `guidfixed` เพราะไม่พกพาข้ามเครื่อง
- field ซ้อน (`children`) รับลึก **2 ชั้นต่อคำสั่ง** — ลึกกว่านั้นได้ error `[FIELD_TOO_DEEP]` พร้อมทางหนี: เรียก `add_field` + `parent` แบบ dotted path เติมทีละชั้น (ข้อจำกัดนี้ทำให้ schema ของ tools/list เล็กลง ~27% คือ 68KB → 50KB และไม่มี `$ref` ที่ client บางตัวปฏิเสธ)
- input มีเพดานขนาด พร้อม error ไทย + code: ชื่อ ≤200 ตัวอักษร (`[VALUE_TOO_LONG]`) · fields ≤300/คำสั่ง (`[TOO_MANY_FIELDS]`) · explicit indexes ≤63/collection และ compound index ≤32 fields (`[TOO_MANY_INDEXES]`/`[TOO_MANY_INDEX_FIELDS]`) โดย linter นับรวม `_id`/unique/key ผสม/relation ไม่ให้เกิน 64 · collections ≤200 (`[TOO_MANY_COLLECTIONS]`) · relations ≤500 (`[TOO_MANY_RELATIONS]`)
- **optimistic concurrency** — ทุก mutation เช็ค `rev` ก่อนเขียน ชนแล้ว retry อัตโนมัติ (อ่านใหม่-ทำซ้ำ สูงสุด 30 รอบ) — AI หลายตัวเขียนพร้อมกันงานไม่ทับกันหายเงียบ
- ลบ field / collection / diagram แล้ว**กวาดเส้นที่เกี่ยวให้ทุก diagram** (รวมเส้นข้ามแท็บ) พร้อมรายงานจำนวนเส้นที่ลบใน response — ไม่ทิ้งเส้นค้าง ไม่ลบเงียบ
- error ทุกตัวมี **machine code** นำหน้าข้อความไทย เช่น `[DUPLICATE_LABEL]` `[DESCRIPTION_NOT_THAI]` `[PROJECT_NOT_FOUND]` `[FIELD_TOO_DEEP]` `[REVISION_NOT_FOUND]` — parse เอาได้

**บังคับคำอธิบายภาษาไทยเสมอ** — ทุก collection/field ที่สร้างหรือแก้ผ่าน MCP ต้องมี `description` ภาษาไทย (เช็กอักขระไทยจริง) ไม่มี/เป็นอังกฤษ = error พร้อมบอกจุด · เรียก `check_descriptions` เพื่อดูของเก่าที่ยังขาดแล้วเติมให้ครบ · ฝั่ง UI ก็บังคับเหมือนกัน: popup คำอธิบาย validate ไทย + จุดที่ขาดมี 💬 สีเหลืองเตือน

- AI แก้ปุ๊บเขียนลง `data/projects.json` ทันที — **UI ที่เปิดอยู่ auto refresh ให้เอง**ภายใน 3 วิ พร้อม toast แจ้ง
- ไม่มี auth — ใช้ในเครื่องเท่านั้น (เหมือน dev server ทั่วไป) แต่มีเกราะพื้นฐาน: `/mcp` เช็ค header `Origin` — request จากเบราว์เซอร์ที่ host ไม่ตรงได้ `403 [FORBIDDEN_ORIGIN]` (กัน CSRF จากเว็บอื่นที่ผู้ใช้เปิดค้าง; MCP client ปกติไม่ส่ง Origin จึงผ่าน) · ชื่อ project ที่ชนกับ `Object.prototype` (`__proto__`, `toString` ฯลฯ) ได้ error ภาษาไทยปกติ ไม่เกิด prototype pollution
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
- พอร์ตผูกที่ **`127.0.0.1` เท่านั้น** (ไม่เปิดให้ทั้ง LAN) — `/mcp` กับ `/api` ไม่มี auth ใครยิงถึงก็ลบทั้งโปรเจกต์ได้ ถ้าต้องการเปิดออก LAN จริงต้องแก้ `docker-compose.yml` เองพร้อมยอมรับความเสี่ยง
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

# regression tests (schema/codegen/lint/key ผสม)
npm test
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
│   ├── mcp/            # MCP server สำหรับ AI ภายนอก (server.ts = tools กลาง, route.ts = HTTP)
│   ├── layout.tsx      # root layout + ฟอนต์ไทย (Noto Sans Thai)
│   ├── globals.css     # ธีม + tweak React Flow
│   └── error.tsx       # error boundary กันจอขาว
├── data/projects.json  # ข้อมูลทุกโปรเจกต์ (สร้างอัตโนมัติ, git-ignored, mount เข้า container)
├── data/history/       # snapshot อัตโนมัติก่อนเขียนทุกครั้ง (20 ไฟล์ล่าสุด — ย้อนด้วย MCP restore_revision)
├── Dockerfile          # production image (Next.js standalone, multi-stage)
├── docker-compose.yml  # รันค้างใน Docker Desktop (พอร์ต 3100, mount ./data)
├── mcp-stdio.ts      # MCP transport แบบ stdio (client spawn เอง — npm run mcp:stdio)
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
4. **เชื่อมความสัมพันธ์:** ลากจากจุดของฟิลด์ FK (เช่น `customer_code`) ไปปล่อยที่**ฟิลด์ business key** ของคอลเลกชันเป้าหมาย (เช่น `customers.code`)
5. **ดับเบิลคลิกที่เส้น** เพื่อสลับ reference/embed และ cardinality
6. กด **▦ จัดผัง** ให้เรียงสวยอัตโนมัติ
7. กด **⚙️ สร้างโค้ด** → เลือกแท็บ mongosh/Go/Mongoose/TypeScript/Wiki → **คัดลอก** ไปใช้
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
    ],
    "indexes": [
      { "id": "idx_customer_type_code",
        "fields": [
          { "field": "customers__type", "direction": 1 },
          { "field": "customers__code", "direction": -1 }
        ],
        "unique": true, "sparse": true }
    ]
  }
}
```

**โครงสร้าง edge (ความสัมพันธ์):** field→field เสมอ — `sourceHandle` = `"<fieldId>-s"` (ฟิลด์ FK ฝั่งลูก), `targetHandle` = `"<fieldId>-t"` (ฟิลด์ business key ฝั่งแม่)
```jsonc
{
  "id": "e1",
  "source": "sales_orders",
  "sourceHandle": "sales_orders__customer_code-s",
  "target": "customers",
  "targetHandle": "customers__code-t",
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
| Generator ทั้งหมด | `schema.ts` (`toMongosh`, `toGo`, `toMongoose`, `toWiki`, `lintModel`, …) |
| Self-check ของ codegen | `schema.ts` → `demo()` (รันตอน dev, throw ถ้าพัง) |
| หน้าเลือก/จัดการโปรเจกต์ | `page.tsx` → `ProjectHome` |
| กล่องคอลเลกชัน (node UI) | `page.tsx` → `CollectionNodeView` |
| Canvas + toolbar + save/load | `page.tsx` → `Designer` |
| หน้า wiki แบบ Obsidian | `wiki/[project]/` (`WikiViewer` + `note.tsx` parser/renderer + `graph.tsx` กราฟ) |
| เตรียมข้อมูล wiki (merge + กราฟ) | `wiki-data.ts` → `getWikiData()` |
| Server store หลาย project (source of truth + rev) | `store.ts` → `data/projects.json` |
| REST CRUD โปรเจกต์ให้ UI | `app/api/projects/route.ts`, `app/api/projects/[name]/route.ts` |
| MCP tools ทั้งหมด | `app/mcp/server.ts` (เพิ่ม tool = `server.registerTool` ใน `createServer()`) — transport: `app/mcp/route.ts` (HTTP), `mcp-stdio.ts` (stdio) |
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
- การเขียนชนกัน (หลาย AI / หลายแท็บแก้พร้อมกัน) กันด้วย **optimistic concurrency (`rev`)** — เขียนด้วย rev เก่าถูกปฏิเสธ ฝั่ง MCP retry ให้อัตโนมัติ ฝั่ง UI ได้ 409 แล้ว auto refresh ของใหม่ก่อน · พลาดจริงยังย้อนได้จาก snapshot อัตโนมัติ (20 จุดล่าสุดใน `data/history/`)
- ไม่มี auth — ออกแบบให้ใช้ในเครื่องเดียว (Docker ผูกพอร์ต `127.0.0.1` เท่านั้น) ห้ามเปิด bind ออก LAN/อินเทอร์เน็ตตรงๆ

---

## 📄 License

MIT — นำไปใช้/ดัดแปลง/ต่อยอดได้อิสระ

---

<sub>สร้างด้วย 🤖 [Claude Code](https://claude.com/claude-code) (Opus · Fable · Sonnet)</sub>
