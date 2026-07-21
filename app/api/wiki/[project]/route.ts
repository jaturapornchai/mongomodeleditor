// app/api/wiki/[project]/route.ts — คืนข้อมูล wiki viewer (WikiData) ของ project เป็น JSON
// ใช้โดย overlay 🌐 ในหน้าเดียวกัน (ไม่ต้องเปิดแท็บใหม่)

import { getWikiData } from "../../../wiki-data";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: RouteContext<"/api/wiki/[project]">) {
  const { project } = await ctx.params;
  const data = await getWikiData(decodeURIComponent(project));
  if (!data) return Response.json({ error: "ไม่พบ project" }, { status: 404 });
  return Response.json(data);
}
