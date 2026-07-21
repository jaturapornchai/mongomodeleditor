// app/store.ts — server-side store: source of truth ของ diagram ทั้งหมด (หลาย project)
// แชร์โดย UI (ผ่าน /api/projects) และ MCP server (ผ่าน /mcp) — pure TS ไม่พึ่ง React/Next
// เก็บไฟล์เดียว data/projects.json — เขียนแบบ atomic (tmp + rename)
// rev: ทั้ง workspace (เปลี่ยนเมื่อ project ไหนก็ได้เปลี่ยน) และต่อ project — UI ใช้ rev ต่อ project
// ตรวจว่ามีคนอื่น (เช่น AI ผ่าน MCP) แก้ project ที่ตัวเองกำลังเปิดอยู่หรือไม่ แล้ว auto refresh

import { promises as fs } from "fs";
import path from "path";

export type StoredDiagram = { nodes: unknown[]; edges: unknown[] };
export type ProjectData = {
  tabs: { id: string; name: string }[];
  cur: string;
  diagrams: Record<string, StoredDiagram>;
};
export type StoredProject = ProjectData & { rev: number; updatedAt: string };
export type Workspace = { rev: number; projects: Record<string, StoredProject> };

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "projects.json");
const LEGACY_FILE = path.join(DATA_DIR, "project.json"); // รูปแบบเก่า (project เดียว) — migrate อัตโนมัติ

const EMPTY: Workspace = { rev: 0, projects: {} };

// คิวเขียนบน globalThis — dev hot-reload อาจสร้าง module instance ซ้ำ กันเขียนไฟล์ชนกันข้าม instance
const g = globalThis as { __mongomodelQueue?: Promise<unknown> };
const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
  const prev = g.__mongomodelQueue ?? Promise.resolve();
  const next = prev.then(job, job);
  g.__mongomodelQueue = next.catch(() => {});
  return next;
};

/** ชื่อ project ต้องไม่ว่างและไม่มีอักขระต้องห้าม (กันพิมพ์พัง/ชน key แปลกๆ) */
export const PROJECT_NAME_RE = /^[^/\\:*?"<>|]{1,80}$/;
export function validProjectName(name: unknown): name is string {
  return typeof name === "string" && name.trim() !== "" && PROJECT_NAME_RE.test(name);
}

async function writeFile(data: Workspace): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

/** migrate ไฟล์รูปแบบเก่า (data/project.json, project เดียว) เข้า workspace เป็น project "default" */
async function migrateLegacy(): Promise<Workspace | null> {
  try {
    const raw = await fs.readFile(LEGACY_FILE, "utf8");
    const p = JSON.parse(raw) as Partial<StoredProject> & Partial<ProjectData>;
    if (!Array.isArray(p.tabs) || typeof p.diagrams !== "object" || p.diagrams === null) return null;
    const ws: Workspace = {
      rev: 1,
      projects: {
        default: {
          rev: typeof p.rev === "number" ? p.rev : 1,
          updatedAt: new Date().toISOString(),
          tabs: p.tabs as ProjectData["tabs"],
          cur: typeof p.cur === "string" ? p.cur : "",
          diagrams: p.diagrams as ProjectData["diagrams"],
        },
      },
    };
    await writeFile(ws);
    await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.bak`).catch(() => {});
    return ws;
  } catch {
    return null;
  }
}

/** อ่าน workspace จากไฟล์เสมอ — ไม่ cache กัน instance คนละตัว (UI route vs MCP route) เห็นข้อมูลเก่า */
export async function getWorkspace(): Promise<Workspace> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const ws = JSON.parse(raw) as Partial<Workspace>;
    if (typeof ws.projects === "object" && ws.projects !== null) {
      return { rev: typeof ws.rev === "number" ? ws.rev : 0, projects: ws.projects };
    }
  } catch {
    // ไฟล์ยังไม่มี / อ่านไม่ได้ → ลอง migrate ของเก่า
  }
  return (await migrateLegacy()) ?? EMPTY;
}

export async function getProject(name: string): Promise<StoredProject | null> {
  const ws = await getWorkspace();
  return ws.projects[name] ?? null;
}

export type ProjectSummary = {
  name: string;
  rev: number;
  updatedAt: string;
  diagrams: number;
  collections: number;
};

export async function listProjects(): Promise<{ rev: number; projects: ProjectSummary[] }> {
  const ws = await getWorkspace();
  const projects = Object.entries(ws.projects).map(([name, p]) => ({
    name,
    rev: p.rev,
    updatedAt: p.updatedAt,
    diagrams: p.tabs.length,
    collections: Object.values(p.diagrams).reduce((n, d) => n + d.nodes.length, 0),
  }));
  projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { rev: ws.rev, projects };
}

/** บันทึก project ทั้งก้อน + เพิ่ม rev (ทั้ง project และ workspace) — auto save ฝั่ง server */
export function saveProject(name: string, data: ProjectData): Promise<number> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    const prev = ws.projects[name];
    const rev = (prev?.rev ?? 0) + 1;
    ws.projects[name] = { rev, updatedAt: new Date().toISOString(), ...data };
    ws.rev += 1;
    await writeFile(ws);
    return rev;
  });
}

export function createProject(name: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    if (ws.projects[name]) throw new Error(`มี project "${name}" อยู่แล้ว`);
    const id = crypto.randomUUID().slice(0, 8);
    ws.projects[name] = {
      rev: 1,
      updatedAt: new Date().toISOString(),
      tabs: [{ id, name: "Main Diagram" }],
      cur: id,
      diagrams: { [id]: { nodes: [], edges: [] } },
    };
    ws.rev += 1;
    await writeFile(ws);
  });
}

export function renameProject(oldName: string, newName: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    const p = ws.projects[oldName];
    if (!p) throw new Error(`ไม่พบ project "${oldName}"`);
    if (ws.projects[newName]) throw new Error(`มี project "${newName}" อยู่แล้ว`);
    delete ws.projects[oldName];
    p.rev += 1;
    p.updatedAt = new Date().toISOString();
    ws.projects[newName] = p;
    ws.rev += 1;
    await writeFile(ws);
  });
}

export function deleteProject(name: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    if (!ws.projects[name]) throw new Error(`ไม่พบ project "${name}"`);
    delete ws.projects[name];
    ws.rev += 1;
    await writeFile(ws);
  });
}
