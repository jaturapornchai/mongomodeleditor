<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MCP server (AI ภายนอกอ่าน/แก้ diagram)

- MCP endpoint = `app/mcp/route.ts` (Streamable HTTP, stateless, `POST` เท่านั้น) — AI เชื่อมที่ `http://localhost:3100/mcp`
- **หลาย project**: source of truth = `data/projects.json` ผ่าน `app/store.ts` (atomic write + `rev` ต่อ project) — **ทุก MCP tool ต้องส่ง `project` (ชื่อ) เสมอ**; UI โหลด/เซฟผ่าน `app/api/projects/*` และ poll `rev` ทุก 3 วิเพื่อ **auto refresh** เมื่อ AI แก้; `localStorage` เป็นแค่ offline cache
- เพิ่ม tool ใหม่: `server.registerTool` ใน `createServer()` ของ `app/mcp/route.ts` — mutation ทุกตัวต้องจบด้วย `save(project, p)` เพื่อ auto save + เพิ่ม rev (ถ้าลืม UI จะไม่ refresh)
- **กฎคำอธิบายภาษาไทยเสมอ**: `add_collection`/`add_field` บังคับ `description` ไทย (zod required + `fieldsThaiError` เช็กอักขระไทย U+0E00–U+0E7F recursive ลง children); `update_collection`/`update_field` บังคับว่าหลังแก้ต้องเหลือคำอธิบายไทย; tool `check_descriptions` รายงานตัวที่ยังขาด; ฝั่ง UI บังคับใน `saveEditing` (`page.tsx`) ด้วย `isThaiText` จาก `schema.ts` + 💬 เหลืองเตือนจุดที่ขาด — ถ้าแก้ schema ของ field input อย่าลืมอัปเดต validation เส้นนี้ด้วย
- **error มี machine code** นำหน้าข้อความไทย เช่น `[PROJECT_NOT_FOUND]` `[DIAGRAM_NOT_FOUND]` `[COLLECTION_NOT_FOUND]` `[FIELD_NOT_FOUND]` `[DESCRIPTION_NOT_THAI]` `[DUPLICATE_LABEL]` — ใส่ code กับ error ใหม่ทุกจุดเสมอ
- `add_collection` ปฏิเสธ label ซ้ำใน diagram เดียวกัน (เว้นแต่ `replace: true` = แทนที่ ลบเส้นเก่าด้วย); bulk import ทั้งผังใช้ `replace_diagram` (validate ก่อนทั้งหมดแล้วเขียน atomic rev +1 ครั้งเดียว)

# Performance (cache/pool — ห้ามแก้โดยไม่เข้าใจ)

- `store.ts` cache workspace ตาม mtime+size (stat ทุกครั้ง) และ**คืน structuredClone เสมอ** — caller mutate ได้โดยไม่ทำ cache สกปรก; write แล้วอัปเดต cache ทันที; ไฟล์ไม่มี/migrate ต้อง bypass
- `wiki-data.ts` cache WikiData ตาม project.rev (key บน globalThis) — rev เปลี่ยนค่อยคำนวณใหม่
- REST ทั้ง 3 (`/api/projects`, `/api/projects/[name]`, `/api/wiki/[project]`) รองรับ `?rev=N` → 204 ว่างเมื่อ rev เดิม; UI poll ทุกจุดส่ง rev ด้วย
- `mcp/route.ts` ใช้ **server pool** แทนสร้าง McpServer ทุก request — ข้อจำกัด SDK 1.29: `connect()` ไม่ล้าง `this._transport` หลัง `close()` ต้องล้างเอง (ผูกกับเวอร์ชัน SDK ที่ pin — อัปเกรด SDK ให้ตรวจจุดนี้); concurrency ปลอดภัยเพราะ checkout เป็น sync pop
- codegen อยู่ใน `app/schema.ts` (pure) — มี `toWiki` ส่งออกชุดไฟล์ markdown โครงสร้าง wikillm (`Home.md` + `collections/` + `types/`) ทั้งใน UI (แท็บ Wiki) และ MCP (`generate_code` format `wiki`)
- หน้า wiki viewer แบบ Obsidian (เขียนเอง ไม่พึ่ง lib ภายนอก) อยู่ที่ `app/wiki/[project]/` — ใช้ 2 ทาง: แผงข้าง canvas ในหน้าเดียวกัน (ปุ่ม 📖 Wiki/🌐, โหลดข้อมูลจาก `GET /api/wiki/[project]`) และ route `/wiki/<ชื่อโปรเจกต์>` สำหรับลิงก์ตรง; parser อยู่ใน `note.tsx` (parse เฉพาะรูปแบบที่ `toWiki` ผลิต — ถ้าแก้ `toWiki` ต้องดู parser ด้วย); ข้อมูลเตรียมจาก `app/wiki-data.ts`
- ReactFlow ของ Designer และของ wiki graph ต้องอยู่คนละ `ReactFlowProvider` (ตอนนี้ provider ครอบ Designer ใน `App`) — รวมกันแล้ว store ชน เตือน node type not found

# Docker

- รัน production ใน Docker Desktop: `npm run docker:up` (build + up -d), หยุด `npm run docker:down`, log `npm run docker:logs`
- `Dockerfile` เป็น multi-stage ตาม `output: "standalone"` ใน `next.config.ts` — รันด้วย `node server.js` ที่พอร์ต 3100 (ENV PORT/HOSTNAME)
- `docker-compose.yml` mount `./data:/app/data` — ข้อมูลโปรเจกต์อยู่บน host ลบ container ไม่หาย; ถ้าแก้โค้ดต้อง `docker:up` ใหม่ (build ใหม่ทุกครั้ง)
- dev ปกติยังใช้ `npm run dev` ได้ (ห้ามรันชนกับ container — พอร์ตเดียวกัน)
