// app/api/projects/route.ts — รายการ project ทั้งหมด + สร้าง project ใหม่
// GET → { rev, projects: [{ name, rev, updatedAt, diagrams, collections }] }
// POST { name } → สร้าง project ว่าง (ชื่อซ้ำ = 409)

import { listProjects, createProject, validProjectName } from "../../store";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await listProjects());
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "body ต้องเป็น JSON" }, { status: 400 });
  }
  const name = (body as Record<string, unknown>)?.name;
  if (!validProjectName(name)) {
    return Response.json({ error: "ชื่อ project ไม่ถูกต้อง (ห้าม / \\ : * ? \" < > |)" }, { status: 400 });
  }
  try {
    await createProject(name.trim());
    return Response.json({ ok: true }, { status: 201 });
  } catch (e) {
    return Response.json({ error: String((e as Error).message) }, { status: 409 });
  }
}
