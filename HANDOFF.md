# HANDOFF — MongoModel

เอกสารส่งมอบงานให้ AI/คนที่มารับต่อ · สถานะ ณ 2026-08-01 · base commit `9957498`

---

## 1. สถานะปัจจุบัน (อ่านก่อน 30 วินาที)

**มีงานค้างใน working tree ที่ยังไม่ commit** — 6 ไฟล์ `+804/-280` เป็นงานสาย **UX/a11y** ล้วน ไม่แตะ MCP/store/API

```
M app/globals.css        (+186) contrast, focus-visible, .mm-ico, cursor, line-height ไทย
M app/layout.tsx          (+10) inline script ตั้งธีมก่อน hydrate
M app/page.tsx           (+769) ก้อนใหญ่ — toolbar, toast, ปุ่มไอคอน, empty state, Esc, ฯลฯ
M app/schema.ts           (+23) lint rule ใหม่ missing-thai-description
M app/wiki/[project]/WikiViewer.tsx (+40) เปลี่ยนไป container query
M app/wiki/[project]/graph.tsx      (+56) ธีมตาม data-theme + fitView ตอน resize
```

**ตรวจแล้วว่าพร้อม commit ไม่ใช่ของครึ่งทาง:**

| เช็ค | ผล |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run build` | ✅ Compiled successfully, 7 routes |
| `demo()` self-check (`app/schema.ts:1321`) | ✅ ผ่าน |
| `npm run lint` | ⚠️ 1 error + 1 warning — **มีมาก่อนแล้วใน HEAD** ไม่ใช่ของใหม่ (ดู §5.4) |

> **ตัดสินใจก่อนเริ่ม:** จะ commit ของค้างนี้ก่อน แล้วค่อยทำงานใหม่ (แนะนำ) หรือทำต่อทับไปเลย
> เจ้าของ (ลุงจืด) ยังไม่ได้สั่ง commit — ต้องถามก่อน

---

## 2. รันและตรวจงานยังไง (เครื่อง Windows + git-bash)

```bash
export PATH="/c/Program Files/nodejs:$PATH" && npm run dev
```

**⚠️ กับดักเครื่องนี้ — เสียเวลาไปแล้ว อย่าเสียซ้ำ:**

1. **`npm`/`npx` เรียกตรงๆ พัง** ("The system cannot find the path specified") เพราะ `~/bin/{node,npm,npx}.bat` ชี้ไป runtime ที่ถูกลบไปแล้ว → **ต้อง prefix `export PATH="/c/Program Files/nodejs:$PATH" &&` ทุกคำสั่ง**
2. **ภาษาไทยเพี้ยนเป็น `????`** เมื่อส่งผ่าน argument ของ bash/curl บน Windows → ทดสอบ MCP ด้วย **Node script + `fetch`** หรือ `PYTHONIOENCODING=utf-8` ห้ามส่งไทยผ่าน argv
3. **พอร์ต 3100 ตายตัว** (`next dev -p 3100`, docker ก็ 3100) — ห้ามรัน dev ชนกับ container
4. **dev server ไม่ hot-reload CSS บางที** ถ้าแก้ `globals.css` แล้วเบราว์เซอร์ยังเห็นของเก่า → kill process แล้ว start ใหม่ (เคยหลงคิดว่าโค้ดไม่ทำงาน ทั้งที่ server ค้างเวอร์ชันเก่า)

**คำสั่งครบชุด:**

| script | ทำอะไร |
|---|---|
| `npm run dev` | dev server พอร์ต **3100** |
| `npm run build` | production build (Next 16 **ไม่รัน eslint** ตอน build) |
| `npm run lint` | `eslint` — ตอนนี้ exit ไม่ 0 (ดู §5.4) |
| `npm run mcp:stdio` | MCP ผ่าน stdio (`tsx mcp-stdio.ts`) ไม่ใช้พอร์ต |
| `npm run docker:up/down/logs` | production ใน Docker (bind `127.0.0.1:3100` เท่านั้น) |

**ไม่มี test framework ในโปรเจกต์** — ไม่มี jest/vitest/playwright ใน `package.json`
regression guard เดียวคือ `demo()` ที่ `app/schema.ts:1321` ซึ่ง `app/page.tsx:67` เรียกตอน dev (throw ถ้า codegen พัง)
→ ถ้าจะเพิ่มเทสต์ ต้องเริ่มจากศูนย์ และควรถามเจ้าของก่อน (เขาชอบให้พิสูจน์ด้วยการ**เล่นจริงบนเบราว์เซอร์**มากกว่าเขียนเทสต์)

---

## 3. แผนที่โค้ด

**สแตก:** Next.js 16.2.10 (App Router, Turbopack) · React 19.2.4 · TypeScript strict · Tailwind v4 · `@xyflow/react` 12.11.2 · `elkjs` · `zod` 4 · `@modelcontextprotocol/sdk` 1.30

**โมเดลข้อมูล:** `project → diagram (แท็บ) → collection (node) → field → relation (edge)`
ไม่ต่อ MongoDB จริง — ทุกอย่างเป็นไฟล์ JSON ที่ `data/projects.json`

| ไฟล์ | บรรทัด | หน้าที่ |
|---|---|---|
| `app/page.tsx` | 4145 | **UI ทั้งแอปไฟล์เดียว** |
| `app/schema.ts` | 1726 | codegen 8 ฟอร์แมต + `lintModel` 18 กฎ (pure ไม่มี side effect) |
| `app/mcp/server.ts` | 1459 | นิยาม **MCP tools 25 ตัว** ทั้งหมด |
| `app/store.ts` | 285 | persistence: atomic write, cache, snapshot, rev |
| `app/wiki-data.ts` | 134 | เตรียม `WikiData` (cache ตาม `project.rev`) |
| `app/wiki/[project]/` | ~800 | wiki viewer แบบ Obsidian (`WikiViewer` / `note` / `graph`) |
| `app/mcp/route.ts` | 57 | MCP over HTTP (stateless + server pool 8 + Origin check) |
| `mcp-stdio.ts` | 23 | MCP over stdio (**chdir ก่อน dynamic import**) |

**จุด anchor ใน `app/page.tsx` (ไฟล์ใหญ่ ต้องรู้ก่อนหา):**

```
67    เรียก demo() regression guard (dev only)
156   sweepCrossTabEdges     192  pinKeyField        226  cloneCollection
314   FieldRow               675  CollectionNodeView 1342 CrossRefNodeView
1387  RelEdgeView            1436 useTheme
1570  Designer   ← canvas + toolbar + codegen (ก้อนหลัก)
3644  ProjectHome            3997 WikiOverlay        4054 App (deep link + popstate)
```

**REST 10 handler / 5 ไฟล์** — ทุกตัว `runtime = "nodejs"` และรองรับ `?rev=N` → `204` เมื่อไม่เปลี่ยน:

```
GET|POST   /api/projects
GET|PUT|PATCH|DELETE /api/projects/[name]     PUT มี expectedRev กัน lost update → 409
GET|POST   /api/revisions                     list / restore snapshot
GET        /api/wiki/[project]
POST       /mcp                               (ไม่มี GET/DELETE)
```

**MCP tools 25 ตัว** (ทั้งหมดอยู่ใน `createServer()` ที่ `app/mcp/server.ts:362`):

```
list_projects create_project rename_project delete_project
list_revisions restore_revision
list_diagrams get_diagram create_diagram rename_diagram delete_diagram switch_diagram
add_collection update_collection delete_collection move_collection
add_field update_field delete_field
add_relation delete_relation
replace_diagram lint_model check_descriptions generate_code
```

**UI auto-refresh:** Designer ส่ง storage signal ทันทีระหว่างแท็บใน browser เดียวกัน + poll fallback 1 วิสำหรับคนละ browser/AI · ProjectHome 5 วิ · Wiki 3 วิ (ส่ง `?rev=` ทุกครั้ง)

---

## 4. INVARIANT — พังแล้วเจ็บ ห้ามแตะโดยไม่อ่าน

อ่าน `AGENTS.md` ให้ครบก่อนแก้อะไร ที่นี่คือข้อที่**เพิ่งเกิดจากงานที่ยังไม่ commit** (ยังไม่ได้เข้า AGENTS.md):

1. **สีเส้นถูก derive ทับ `e.style` แล้ว** — `displayEdges` (`app/page.tsx:2220-2227`) spread เป็น `{animationDirection, ...e.style, stroke, strokeWidth}` → `stroke`/`strokeWidth` คำนวณใหม่ทุก render จาก `e.data.kind` (embed ม่วง `#a78bfa` / reference เทา `#64748b`) และ `e.data.cardinality` (n-n 2.5 / 1-n 2 / อื่น 1.5) **ทับค่าที่ persist**
   → แก้สีเส้นได้ที่ `displayEdges` **จุดเดียว** · เขียน `style.stroke` ลง edge จะไม่มีผล (`onEdgeDoubleClick:2111`, `defaultEdgeOptions:3079` เหลือมีผลแค่ `strokeDasharray`)
2. **ความกว้างการ์ดขั้นต่ำมี 2 ที่ ต้องขยับคู่กัน** — `min-w-[27rem]` ของ `.mm-card` (`app/page.tsx:988`) กับ `minWidth={432}` ของ `NodeResizeControl` (`:996`) และ fallback ใน `cloneCollection` (`:234`) แก้ที่เดียว = ลากย่อแล้วแถวฟิลด์แตก
3. **toast ต้องเรียกผ่าน `notify()` / `notifySweep()`** (`app/page.tsx:1606-1620`) ห้าม `setAiNotice` ตรงๆ — helper เคลียร์ timer ตัวเก่าก่อนตั้งใหม่ ไม่งั้น toast ตัวที่ 2 ถูก timer ตัวแรกฆ่าก่อนเวลา
4. **`.mm-toolbar` ต้องอยู่นอก `@layer`** (`app/globals.css:346-352`) — กฎนอก layer ชนะกฎใน layer เสมอ อยู่ใน layer แล้วแพ้ `*{scrollbar-width:thin}` → รางเลื่อนโผล่
5. **ปุ่มไอคอนใหม่ต้องใช้คลาส `.mm-ico`** (`app/globals.css:186-205`) = 24×24px ตาม WCAG 2.5.8 พร้อม margin ลบดึงเลย์เอาต์กลับ — ห้ามเขียน `text-[10px]` เปล่าๆ
6. **wiki ใช้ container query ห้ามกลับไป `sm:`/`md:`** (`WikiViewer.tsx:102,163`) เพราะ wiki ถูกใช้ 2 ทาง (route เต็มจอ + แผงข้าง canvas) breakpoint ต้องวัดจากความกว้าง**แผง** ไม่ใช่จอ
7. **`THEME_KEY` ฮาร์ดโค้ด 2 ที่** — สตริงใน `app/layout.tsx:22` (inline script ก่อน hydrate) กับ `app/page.tsx:1434` แก้ที่เดียวแล้วลืมอีกที่ = จอกระพริบ/ธีมผิดตอนโหลด และเป็นเหตุที่ `useTheme` ต้องมี `themeBooted` ref ข้าม effect รอบแรก
8. **`addCollection` ยิง `dblclick` ใส่ DOM เพื่อเข้าโหมดแก้ชื่อ** (`app/page.tsx:2441-2447`) — เล็ง `.react-flow__node[data-id] .mm-card-head span` ตัวแรก **ถ้าเพิ่ม `<span>` ก่อนชื่อการ์ด ฟีเจอร์นี้พังเงียบ** (จงใจเลือกทางนี้แทนธง `autoEdit` ที่จะติดไปกับไฟล์ที่บันทึก)
9. **`cloneCollection(n, all)` เปลี่ยน signature** — พารามิเตอร์ที่ 2 default `[]` ถ้าลืมส่ง **คอมไพล์ผ่านแต่พฤติกรรมถอยกลับ** (สำเนาทับกันเป๊ะ + ชื่อ `_copy` ซ้ำ) call site ปัจจุบัน 5 จุด

**ข้อที่มีอยู่ก่อนแล้วและสำคัญไม่แพ้กัน** (รายละเอียดเต็มใน `AGENTS.md`): relation ห้ามอ้าง `guidfixed` · relation เป็น field→field เสมอ · คำอธิบายต้องเป็นภาษาไทย · ห้าม recursive zod ใน MCP tools (จำกัด children 2 ชั้น) · error ทุกตัวขึ้นต้นด้วย machine code `[CODE]` · เส้นข้ามแท็บเก็บที่ diagram ต้นทางเสมอ · Docker bind `127.0.0.1` เท่านั้น (ไม่มี auth)

---

## 5. งานค้าง — เรียงตามความคุ้ม

### 5.1 ผังใหญ่ทับกันตอน zoom ต่ำ 🔴 ผลกระทบสูงสุด
**อาการ:** เปิดโปรเจกต์จริง (เช่น `BC Ai Account` — 20 collection, การ์ด `branch` มี 60 ฟิลด์) แล้วซูมออก การ์ดสูงมากทับกันจนอ่านไม่ออก
**สาเหตุ:** auto-layout (ELK) จัดตำแหน่งจากขนาดการ์ด แต่การ์ดสูงไม่จำกัด และไม่มีโหมดย่อตอนซูมต่ำ
**แนวทางที่คิดไว้ (ยังไม่ได้ตัดสินใจ):** LOD — ต่ำกว่า zoom ~0.4 ให้ `CollectionNodeView` เรนเดอร์แค่หัวการ์ด + จำนวนฟิลด์ (ดู `useStore(s => s.transform[2])` ของ React Flow) · หรือ auto-collapse ฟิลด์ที่ไม่ใช่ key
**ที่ต้องแตะ:** `app/page.tsx:675` (CollectionNodeView), `autoLayout` ใน Designer
**เตือน:** เป็นงานใหญ่ ต้องคุยกับเจ้าของก่อนลงมือ (กฎ SCOPE DRIFT)

### 5.2 modal confirm แทน `window.confirm` 🟡 เจ้าของสั่งไว้ในคอมมิตล่าสุด
เหลือ native `confirm()` **4 จุด**: `app/page.tsx:940` (ทิ้งข้อความใน popup คำอธิบาย), `:2048` (ลบแท็บ diagram), `:3056` (`onBeforeDelete` ลบคอลเลกชัน), `:3599` (หน้ารายชื่อโปรเจกต์)
มีตัวอย่างที่ทำแล้วให้ลอกโครง: การลบโปรเจกต์ใช้ modal ของแอปเอง (`app/page.tsx:3765` มีคอมเมนต์อธิบายว่าทำไม — native confirm โดน auto-dismiss ใน automation/บาง browser)
งานคือทำ **shared component** แล้วแทนทั้ง 4 จุด

### 5.3 `Ctrl+wheel` = zoom 🟡 เจ้าของสั่งไว้ แต่ระวัง breaking
ตอนนี้: wheel เปล่า = ซูม, `Ctrl+wheel` = เลื่อนจอ, `Shift+wheel` = แพนแนวนอน — **สลับกับ Figma/Notion**
`<ReactFlow>` (`app/page.tsx:3016`) ไม่ได้ตั้ง `zoomOnScroll`/`panOnScroll` เลย (ใช้ default v12 = wheel ซูม)
ต้องแตะ: `onWheel` (`:1654,1662-1664`) + ข้อความช่วยเหลือ (`:3202-3204`)
**เจ้าของรู้แล้วและจงใจเลื่อนไว้** เพราะจะ break ความเคยชินของผู้ใช้เดิม → ห้ามแก้เองโดยไม่ถาม

### 5.4 `npm run lint` ไม่ผ่าน 🟢 เล็ก แต่บล็อก CI
- `app/page.tsx:1447` **error** `react-hooks/set-state-in-effect` — `setTheme(initial)` เรียกตรงๆ ใน body ของ `useEffect` (**มีอยู่ก่อนแล้วใน HEAD** ไม่ใช่ของใหม่) แก้โดยย้ายไป lazy initializer ของ `useState` หรือ `useSyncExternalStore`
- `app/page.tsx:1373` **warning** `LANE_SIDE` ประกาศแล้วไม่มีใครใช้ = **dead code ยืนยันแล้ว ลบได้ปลอดภัย** (`LANE_STEP` ข้างๆ ใช้จริงที่ `:1410`)
  ⚠️ ทั้งสองจุด**อยู่นอกขอบเขตงาน UX รอบล่าสุด** จึงยังไม่ลบ — flag ไว้ให้เจ้าของตัดสิน

### 5.5 หนี้เชิงโครงสร้าง 🟢 ไม่เร่ง แต่จะกัดทีหลัง
- **`ProjectSummary` นิยามซ้ำ 2 ที่เหมือนกันเป๊ะ** — `app/store.ts:196` (export แต่ไม่มีใคร import) กับ `app/page.tsx:3636` (ประกาศเอง) → เพิ่ม field ฝั่ง `listProjects()` แล้วลืมฝั่ง UI จะ drift เงียบ TypeScript จับไม่ได้
- **`missing-thai-description` ทับซ้อนกับ MCP tool `check_descriptions`** — กฎ lint ใหม่ (`app/schema.ts:1163-1186`, ยังไม่ commit) รายงานเรื่องเดียวกับ tool เฉพาะทางที่มีอยู่แล้ว (`app/mcp/server.ts:625`) ตอนนี้มี 2 ทางรายงาน **ยังไม่ตัดสินใจว่าจะยุบตัวไหน**
  ⚠️ **ผลข้างเคียงที่ต้องรู้:** ตัวเลขบนปุ่ม 🩺 ตรวจ และ output ของ MCP `lint_model` จะ**พุ่งขึ้นมาก**ในโปรเจกต์เก่าที่คำอธิบายไทยยังไม่ครบ — **นี่คือของตั้งใจ ไม่ใช่ regression**
- **`ponytail:` 2 จุดที่มี upgrade path เขียนกำกับไว้:** `app/mcp/server.ts:152` (retry 30 รอบ → ถ้า contention สูงจริงให้ย้าย read-modify-write เข้าคิวเขียนใน `store.ts`) และ `app/page.tsx:2441` (dblclick hack ข้อ 8 ข้างบน)
- **ไม่มี `TODO`/`FIXME`/`HACK` ในโปรเจกต์เลยแม้แต่ตัวเดียว** — อย่าเสียเวลาไล่หา ของค้างอยู่ใน commit message กับคอมเมนต์ `ponytail:` เท่านั้น

### 5.6 ยังไม่ได้เริ่มเลย
- onboarding ครั้งแรก (เปิดแอปครั้งแรกแล้วไม่รู้จะเริ่มยังไง)
- `data/projects.backup-uat.json` (256KB, เหลือจาก UAT 29 ก.ค.) และ `data/project.json.bak` ค้างอยู่ — `data/` ถูก gitignore แล้ว **ห้ามลบเองเพราะเป็นข้อมูลงานผู้ใช้ ต้องถามเจ้าของ**

---

## 6. กติกาของเจ้าของงาน (ลุงจืด) — ผิดข้อไหนคืองานไม่ผ่าน

1. **สื่อสารภาษาไทย สั้น กระชับ** เรียกเจ้าของว่า "ลุงจืด"
2. **ห้ามบอก "เสร็จ" ถ้ายังไม่มีหลักฐาน** — ต้องมี output ของ build/test/screenshot/ค่าที่วัดได้จริง คำว่า "น่าจะ work" ห้ามใช้
3. **ห้ามเดา** ไม่รู้ path/โครงสร้างให้ถามหรือบอกว่าสมมติอะไร ห้ามแต่งชื่อ function/API ที่ไม่มีจริง
4. **งาน 1 บรรทัด = แก้ 1 บรรทัด** เจอบั๊กอื่นระหว่างทาง → **flag ก่อน อย่าแก้เอง**
5. **R0 (ถอยไม่ได้) ต้องถามก่อน** — force-push, ลบข้อมูล, deploy · R1 (แก้ contract/schema) ทำได้แต่ต้องบอกเหตุผลก่อน · R2 (แก้ไฟล์ local, run test) ทำเลย
6. **จบงานต้องกวาด dead code ที่งานนั้นทำให้ตาย** แล้ว verify ซ้ำว่ายัง build ผ่าน (ของนอกขอบเขตให้ flag ไม่ลบเงียบๆ)
7. **ปิดท้ายทุก task ด้วย ✅ ข้อดี / ⚠️ ข้อเสีย-ความเสี่ยง / 💡 คำแนะนำ** — ห้าม generic ต้องเจาะจงกับงานนั้น และต้องพยายามหาข้อเสียให้เจอ (95% ของการเปลี่ยนแปลงมีข้อเสียอย่างน้อย 1 ข้อ)
8. **commit/push เมื่อสั่งเท่านั้น** ไม่สั่งไม่ต้องทำ

---

## 7. Definition of done ของงานนี้

ก่อนบอกว่าเสร็จ ต้องผ่านครบ:

```bash
export PATH="/c/Program Files/nodejs:$PATH" && npx tsc --noEmit && npm run build
```

แล้ว**เปิดเบราว์เซอร์ดูจริง**ที่ `http://localhost:3100`:
- ทดสอบ **ทั้งโหมดมืดและโหมดสว่าง** (ปุ่มมุมขวาบน)
- ทดสอบที่ **1280 และ 1440 px** เป็นอย่างน้อย (ปุ่ม toolbar เคยหลุดจอที่ความกว้างนี้)
- ถ้าแตะ wiki: ทดสอบ **ทั้ง 2 ทาง** — แผงข้าง canvas (ปุ่ม 📖 Wiki) และ route `/wiki/<ชื่อโปรเจกต์>`
- ถ้าแตะ MCP: ยิงจริงทั้ง 2 transport (`POST /mcp` และ `npm run mcp:stdio`) **ด้วย Node script ไม่ใช่ curl** (ปัญหา encoding ไทย)

---

## 8. เอกสารอื่นที่ต้องอ่าน

| ไฟล์ | เนื้อหา |
|---|---|
| `AGENTS.md` | **กฎโปรเจกต์ฉบับเต็ม** — MCP, invariant, performance, docker · `CLAUDE.md` แค่ `@AGENTS.md` |
| `README.md` | คู่มือผู้ใช้ภาษาไทย + ข้อจำกัด 4 ข้อ (บรรทัด 376-383) |
| `git log` | ของค้าง/เหตุผลการตัดสินใจอยู่ใน commit body ภาษาไทย — `git log -1 --format=%B <sha>` |
