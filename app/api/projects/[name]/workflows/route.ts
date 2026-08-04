import {
  RevConflictError,
  getProject,
  saveProject,
  type StoredProject,
} from "../../../../store";
import { workflowInputError, type Workflow } from "../../../../workflow";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ name: string }> };
type RawField = { id?: unknown; name?: unknown; type?: unknown; children?: RawField[] };
type RawNode = { id?: unknown; data?: { label?: unknown; fields?: RawField[] } };

const projectData = (p: StoredProject, workflows: Record<string, Workflow>) => ({
  tabs: p.tabs,
  cur: p.cur,
  diagrams: p.diagrams,
  workflows,
});

const collectionOptions = (p: StoredProject) => {
  const out: {
    id: string;
    label: string;
    diagram: string;
    diagramName: string;
    fields: { id: string; path: string; type: string }[];
  }[] = [];
  const walk = (fields: RawField[], parent = ""): { id: string; path: string; type: string }[] =>
    fields.flatMap((field) => {
      if (typeof field.id !== "string" || typeof field.name !== "string") return [];
      const path = parent ? `${parent}.${field.name}` : field.name;
      return [
        { id: field.id, path, type: typeof field.type === "string" ? field.type : "Mixed" },
        ...walk(Array.isArray(field.children) ? field.children : [], path),
      ];
    });
  for (const tab of p.tabs) {
    const diagram = p.diagrams[tab.id];
    if (!diagram) continue;
    for (const node of diagram.nodes as RawNode[])
      if (typeof node.id === "string" && typeof node.data?.label === "string")
        out.push({
          id: node.id,
          label: node.data.label,
          diagram: tab.id,
          diagramName: tab.name,
          fields: walk(Array.isArray(node.data.fields) ? node.data.fields : []),
        });
  }
  return out;
};

const parseBody = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const conflictResponse = (error: unknown) =>
  error instanceof RevConflictError
    ? Response.json({ error: error.message, current: error.current }, { status: 409 })
    : null;

export async function GET(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const p = await getProject(decodeURIComponent(name));
  if (!p) return Response.json({ error: "[PROJECT_NOT_FOUND] ไม่พบ project" }, { status: 404 });
  const rawRev = new URL(req.url).searchParams.get("rev");
  if (rawRev !== null && rawRev !== "" && Number(rawRev) === p.rev)
    return new Response(null, { status: 204 });
  return Response.json({
    rev: p.rev,
    workflows: Object.values(p.workflows ?? {}),
    collections: collectionOptions(p),
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await parseBody(req);
  if (!body) return Response.json({ error: "[INVALID_JSON] body ต้องเป็น JSON object" }, { status: 400 });
  const error = workflowInputError(body.workflow);
  if (error) return Response.json({ error }, { status: 400 });
  const workflow = body.workflow as Workflow;
  const projectName = decodeURIComponent(name);
  const p = await getProject(projectName);
  if (!p) return Response.json({ error: "[PROJECT_NOT_FOUND] ไม่พบ project" }, { status: 404 });
  const workflows = p.workflows ?? {};
  if (workflows[workflow.id])
    return Response.json({ error: `[DUPLICATE_WORKFLOW] workflow id \"${workflow.id}\" มีอยู่แล้ว` }, { status: 409 });
  if (Object.values(workflows).some((item) => item.name === workflow.name))
    return Response.json({ error: `[DUPLICATE_WORKFLOW_NAME] workflow \"${workflow.name}\" มีอยู่แล้ว` }, { status: 409 });
  try {
    const rev = await saveProject(
      projectName,
      projectData(p, { ...workflows, [workflow.id]: workflow }),
      typeof body.expectedRev === "number" ? body.expectedRev : p.rev,
    );
    return Response.json({ rev, workflow }, { status: 201 });
  } catch (e) {
    const conflict = conflictResponse(e);
    if (conflict) return conflict;
    throw e;
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await parseBody(req);
  if (!body) return Response.json({ error: "[INVALID_JSON] body ต้องเป็น JSON object" }, { status: 400 });
  const error = workflowInputError(body.workflow);
  if (error) return Response.json({ error }, { status: 400 });
  const workflow = body.workflow as Workflow;
  const projectName = decodeURIComponent(name);
  const p = await getProject(projectName);
  if (!p) return Response.json({ error: "[PROJECT_NOT_FOUND] ไม่พบ project" }, { status: 404 });
  const workflows = p.workflows ?? {};
  if (!workflows[workflow.id])
    return Response.json({ error: `[WORKFLOW_NOT_FOUND] ไม่พบ workflow \"${workflow.id}\"` }, { status: 404 });
  if (Object.values(workflows).some((item) => item.id !== workflow.id && item.name === workflow.name))
    return Response.json({ error: `[DUPLICATE_WORKFLOW_NAME] workflow \"${workflow.name}\" มีอยู่แล้ว` }, { status: 409 });
  try {
    const rev = await saveProject(
      projectName,
      projectData(p, { ...workflows, [workflow.id]: workflow }),
      typeof body.expectedRev === "number" ? body.expectedRev : p.rev,
    );
    return Response.json({ rev, workflow });
  } catch (e) {
    const conflict = conflictResponse(e);
    if (conflict) return conflict;
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const body = await parseBody(req);
  if (!body || typeof body.id !== "string")
    return Response.json({ error: "[INVALID_ARGUMENT] ต้องระบุ workflow id" }, { status: 400 });
  const projectName = decodeURIComponent(name);
  const p = await getProject(projectName);
  if (!p) return Response.json({ error: "[PROJECT_NOT_FOUND] ไม่พบ project" }, { status: 404 });
  const workflows = { ...(p.workflows ?? {}) };
  if (!workflows[body.id])
    return Response.json({ error: `[WORKFLOW_NOT_FOUND] ไม่พบ workflow \"${body.id}\"` }, { status: 404 });
  delete workflows[body.id];
  try {
    const rev = await saveProject(
      projectName,
      projectData(p, workflows),
      typeof body.expectedRev === "number" ? body.expectedRev : p.rev,
    );
    return Response.json({ rev, id: body.id });
  } catch (e) {
    const conflict = conflictResponse(e);
    if (conflict) return conflict;
    throw e;
  }
}
