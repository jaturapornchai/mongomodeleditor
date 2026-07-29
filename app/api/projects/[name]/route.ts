// app/api/projects/[name]/route.ts — project เดียว: อ่าน / บันทึก / เปลี่ยนชื่อ / ลบ
// GET → project เต็ม (tabs, cur, diagrams, rev, updatedAt) · PUT → เขียนทับทั้งก้อน คืน rev ใหม่
// PATCH { name } → เปลี่ยนชื่อ · DELETE → ลบ project

import {
  RevConflictError,
  getProject,
  saveProject,
  renameProject,
  deleteProject,
  validProjectName,
  type ProjectData,
} from "../../../store";

export const runtime = "nodejs";

type Ctx = RouteContext<"/api/projects/[name]">;

export async function GET(_req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const p = await getProject(decodeURIComponent(name));
  if (!p) return Response.json({ error: "ไม่พบ project" }, { status: 404 });
  // conditional: rev เดิม = ไม่ต้องส่งข้อมูล (UI poll ทุก 3 วิ) — ?rev ว่าง/ไม่ใช่ตัวเลข = ตอบปกติ
  const rawRev = new URL(_req.url).searchParams.get("rev");
  if (rawRev !== null && rawRev !== "" && Number(rawRev) === p.rev) {
    return new Response(null, { status: 204 });
  }
  return Response.json(p);
}

export async function PUT(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body ต้องเป็น JSON" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.tabs) || typeof b.diagrams !== "object" || b.diagrams === null) {
    return Response.json({ error: "ต้องมี tabs (array) และ diagrams (object)" }, { status: 400 });
  }
  // expectedRev (ถ้าส่งมา) = rev ที่ client ถืออยู่ — ไม่ตรงแปลว่ามีคนอื่น (แท็บอื่น/AI ผ่าน MCP)
  // แก้ไปแล้ว ต้องให้ client รีเฟรชก่อน ไม่ใช่เขียนทับงานเขาหายเงียบ
  try {
    const rev = await saveProject(
      decodeURIComponent(name),
      {
        tabs: b.tabs as ProjectData["tabs"],
        cur: typeof b.cur === "string" ? b.cur : "",
        diagrams: b.diagrams as ProjectData["diagrams"],
      },
      typeof b.expectedRev === "number" ? b.expectedRev : undefined,
    );
    return Response.json({ rev });
  } catch (e) {
    if (e instanceof RevConflictError) {
      return Response.json({ error: e.message, current: e.current }, { status: 409 });
    }
    throw e;
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body ต้องเป็น JSON" }, { status: 400 });
  }
  const newName = (body as Record<string, unknown>)?.name;
  if (!validProjectName(newName)) {
    return Response.json({ error: "ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)" }, { status: 400 });
  }
  try {
    await renameProject(decodeURIComponent(name), newName.trim());
    return Response.json({ ok: true });
  } catch (e) {
    const msg = String((e as Error).message);
    // ชื่อใหม่ซ้ำ = 409 (แพทเทิร์นเดียวกับ POST ชื่อซ้ำ / PUT rev ชน) · ไม่พบ project เดิม = 404
    return Response.json({ error: msg }, { status: msg.includes("[DUPLICATE_PROJECT]") ? 409 : 404 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  try {
    await deleteProject(decodeURIComponent(name));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 404 });
  }
}
