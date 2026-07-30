// app/api/revisions/route.ts — ประวัติ snapshot ของ workspace (data/history/*.json)
// GET → { revisions: [{ rev, savedAt }] } ใหม่สุดก่อน · POST { rev } → กู้คืนทั้ง workspace กลับไปที่ snapshot นั้น
// เปิดของที่มีอยู่แล้วฝั่ง MCP (list_revisions/restore_revision) ให้ UI ผู้ใช้ทั่วไปกดใช้เอง
// endpoint ไม่มี auth เหมือนตัวอื่น — ผูกอยู่กับ 127.0.0.1 เท่านั้น (ดู docker-compose)

import { listRevisions, restoreRevision } from "../../store";

export const runtime = "nodejs";

export async function GET() {
  const revs = await listRevisions();
  return Response.json({ revisions: revs.map(({ rev, savedAt }) => ({ rev, savedAt })) });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body ต้องเป็น JSON" }, { status: 400 });
  }
  const rev = (body as Record<string, unknown>)?.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 0) {
    return Response.json({ error: "ต้องส่ง rev (เลข snapshot จาก GET /api/revisions)" }, { status: 400 });
  }
  try {
    const r = await restoreRevision(rev);
    return Response.json(r);
  } catch {
    return Response.json(
      { error: `[REVISION_NOT_FOUND] ไม่พบ snapshot rev ${rev} — ดูรายการที่มีด้วย GET /api/revisions` },
      { status: 404 },
    );
  }
}
