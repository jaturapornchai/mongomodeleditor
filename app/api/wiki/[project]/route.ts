// app/api/wiki/[project]/route.ts — คืนข้อมูล wiki viewer (WikiData) ของ project เป็น JSON
// ใช้โดย overlay 🌐 ในหน้าเดียวกัน (ไม่ต้องเปิดแท็บใหม่)

import { getWikiData } from "../../../wiki-data";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: RouteContext<"/api/wiki/[project]">) {
  const { project } = await ctx.params;
  const data = await getWikiData(decodeURIComponent(project));
  if (!data) return Response.json({ error: "ไม่พบ project" }, { status: 404 });
  // conditional: rev เดิม = ไม่ต้องส่งข้อมูล (wiki overlay poll ทุก 3 วิ)
  const rawRev = new URL(_req.url).searchParams.get("rev");
  if (rawRev !== null && rawRev !== "" && Number(rawRev) === data.rev) {
    return new Response(null, { status: 204 });
  }
  return Response.json(data);
}
