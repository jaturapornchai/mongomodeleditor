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
const g = globalThis as {
  __mongomodelQueue?: Promise<unknown>;
  __mongomodelWsCache?: { data: Workspace; mtimeMs: number; size: number };
};
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

const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_KEEP = 20; // เก็บ snapshot ล่าสุดกี่ไฟล์

/**
 * เก็บสำเนาไฟล์ปัจจุบันไว้ก่อนถูกเขียนทับ — เครื่องมือนี้ให้ AI แก้โมเดลผ่าน MCP ได้
 * เรียก replace_diagram/delete_project ผิดครั้งเดียวคืองานทั้งโปรเจกต์หายถาวร
 * (undo อยู่ในเบราว์เซอร์อย่างเดียวและล้างเมื่อสลับ diagram)
 */
async function snapshot(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch {
    return; // ยังไม่มีไฟล์ = ไม่มีอะไรให้สำรอง
  }
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  let rev = 0;
  try {
    rev = (JSON.parse(raw) as Workspace).rev ?? 0;
  } catch {
    /* ไฟล์เสีย — ยังคุ้มที่จะเก็บไว้ */
  }
  const stamp = String(rev).padStart(6, "0");
  await fs.writeFile(path.join(HISTORY_DIR, `projects-${stamp}.json`), raw, "utf8");
  // ลบของเก่าเกินโควตา (เรียงตามชื่อ = เรียงตาม rev)
  const files = (await fs.readdir(HISTORY_DIR))
    .filter((f) => f.startsWith("projects-") && f.endsWith(".json"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
    await fs.rm(path.join(HISTORY_DIR, f)).catch(() => {});
  }
}

/** รายการ snapshot ที่มี — ใหม่สุดก่อน */
export async function listRevisions(): Promise<{ rev: number; file: string; savedAt: string }[]> {
  let files: string[];
  try {
    files = await fs.readdir(HISTORY_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.filter((x) => x.startsWith("projects-") && x.endsWith(".json"))) {
    const st = await fs.stat(path.join(HISTORY_DIR, f)).catch(() => null);
    if (!st) continue;
    out.push({ rev: Number(f.slice(9, -5)), file: f, savedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.rev - a.rev);
}

/** ย้อนทั้ง workspace กลับไปที่ snapshot หนึ่ง (ตัวปัจจุบันถูก snapshot ไว้ก่อนเสมอ) */
export function restoreRevision(rev: number): Promise<{ rev: number; projects: string[] }> {
  return enqueue(async () => {
    const raw = await fs.readFile(
      path.join(HISTORY_DIR, `projects-${String(rev).padStart(6, "0")}.json`),
      "utf8",
    );
    const ws = JSON.parse(raw) as Workspace;
    const cur = await getWorkspace();
    ws.rev = cur.rev + 1; // เดินหน้าต่อจากของปัจจุบัน ไม่ย้อน rev (กัน client cache ค้าง)
    await writeFile(ws);
    return { rev: ws.rev, projects: Object.keys(ws.projects) };
  });
}

async function writeFile(data: Workspace): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await snapshot();
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  // อัปเดต cache ด้วย snapshot ที่เพิ่งเขียน + stat ใหม่ — กัน mtime resolution หยาบบน Docker bind mount
  try {
    const st = await fs.stat(FILE);
    g.__mongomodelWsCache = { data: structuredClone(data), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    delete g.__mongomodelWsCache;
  }
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

/**
 * อ่าน workspace — cache ตาม mtime+size (fs.stat ทุกครั้งถูกมาก แต่ parse เฉพาะเมื่อไฟล์เปลี่ยน)
 * คืน structuredClone เสมอ — caller (tools/save) mutate ได้โดยไม่ทำ cache สกปรก
 * ไฟล์ไม่มี/migrate → bypass cache (ห้าม cache EMPTY ค้าง)
 */
export async function getWorkspace(): Promise<Workspace> {
  try {
    const st = await fs.stat(FILE);
    const c = g.__mongomodelWsCache;
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
      return structuredClone(c.data);
    }
    const raw = await fs.readFile(FILE, "utf8");
    const ws = JSON.parse(raw) as Partial<Workspace>;
    if (typeof ws.projects === "object" && ws.projects !== null) {
      const data: Workspace = {
        rev: typeof ws.rev === "number" ? ws.rev : 0,
        projects: ws.projects,
      };
      g.__mongomodelWsCache = { data: structuredClone(data), mtimeMs: st.mtimeMs, size: st.size };
      return data; // เพิ่ง parse เอง — cache เก็บ clone แยก caller แตะไม่ถึง
    }
  } catch {
    // ไฟล์ยังไม่มี / อ่านไม่ได้ → ลอง migrate ของเก่า (bypass cache)
  }
  return (await migrateLegacy()) ?? structuredClone(EMPTY);
}

// projects ถูก index ด้วยชื่อจาก input — ชื่อที่ชนของบน Object.prototype (toString/constructor/__proto__)
// ต้องอ่านผ่าน hasOwn (กันหยิบของ inherit มาแล้วพังเป็น TypeError อังกฤษดิบ) และเขียนผ่าน
// defineProperty (กัน "__proto__" ไปสลับ prototype แทนที่จะสร้าง project จริง) — จุดเดียวคุมทั้ง MCP และ REST
const readProject = (ws: Workspace, name: string): StoredProject | undefined =>
  Object.hasOwn(ws.projects, name) ? ws.projects[name] : undefined;
const writeProject = (ws: Workspace, name: string, p: StoredProject): void => {
  Object.defineProperty(ws.projects, name, {
    value: p,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

export async function getProject(name: string): Promise<StoredProject | null> {
  const ws = await getWorkspace();
  return readProject(ws, name) ?? null;
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

/** เขียนทับงานคนอื่น — PUT/MCP ที่ถือ rev เก่าจะโดน error นี้ (ตัวเรียกแปลงเป็น HTTP 409) */
export class RevConflictError extends Error {
  constructor(readonly current: number, readonly expected: number) {
    super(`project ถูกแก้โดยที่อื่นแล้ว (rev ปัจจุบัน ${current} แต่ส่งมา ${expected})`);
    this.name = "RevConflictError";
  }
}

/**
 * บันทึก project ทั้งก้อน + เพิ่ม rev (ทั้ง project และ workspace) — auto save ฝั่ง server
 * ส่ง expectedRev มาด้วยเพื่อกัน lost update: UI autosave 400ms/poll fallback 1 วิ และ AI แก้ผ่าน MCP
 * พร้อมกันได้ ใครเขียนช้ากว่าจะทับงานอีกฝั่งหายเงียบถ้าไม่เช็ค
 */
export function saveProject(name: string, data: ProjectData, expectedRev?: number): Promise<number> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    const prev = readProject(ws, name);
    if (expectedRev !== undefined && prev && prev.rev !== expectedRev) {
      throw new RevConflictError(prev.rev, expectedRev);
    }
    const rev = (prev?.rev ?? 0) + 1;
    writeProject(ws, name, { rev, updatedAt: new Date().toISOString(), ...data });
    ws.rev += 1;
    await writeFile(ws);
    return rev;
  });
}

export function createProject(name: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    if (readProject(ws, name)) throw new Error(`[DUPLICATE_PROJECT] มี project "${name}" อยู่แล้ว`);
    const id = crypto.randomUUID().slice(0, 8);
    writeProject(ws, name, {
      rev: 1,
      updatedAt: new Date().toISOString(),
      tabs: [{ id, name: "Main Diagram" }],
      cur: id,
      diagrams: { [id]: { nodes: [], edges: [] } },
    });
    ws.rev += 1;
    await writeFile(ws);
  });
}

export function renameProject(oldName: string, newName: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    const p = readProject(ws, oldName);
    if (!p) throw new Error(`[PROJECT_NOT_FOUND] ไม่พบ project "${oldName}"`);
    if (readProject(ws, newName)) throw new Error(`[DUPLICATE_PROJECT] มี project "${newName}" อยู่แล้ว`);
    delete ws.projects[oldName];
    p.rev += 1;
    p.updatedAt = new Date().toISOString();
    writeProject(ws, newName, p);
    ws.rev += 1;
    await writeFile(ws);
  });
}

export function deleteProject(name: string): Promise<void> {
  return enqueue(async () => {
    const ws = await getWorkspace();
    if (!readProject(ws, name)) throw new Error(`[PROJECT_NOT_FOUND] ไม่พบ project "${name}"`);
    delete ws.projects[name];
    ws.rev += 1;
    await writeFile(ws);
  });
}
