// app/wiki/[project]/WikiViewer.tsx — หน้า wiki แบบ Obsidian: explorer + note + กราฟ + backlinks + Ctrl+K
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { parseNote, NoteView, type ParsedNote } from "./note";
import WikiGraph from "./graph";
import type { WikiData } from "../../wiki-data";

type Section = { key: string; title: string; icon: string; paths: string[] };

const baseOf = (path: string) => path.replace(/\.md$/, "").split("/").pop() ?? path;

export default function WikiViewer({ data, onClose }: { data: WikiData; onClose?: () => void }) {
  const { project, files, gNodes, gEdges } = data;
  const paths = useMemo(() => Object.keys(files), [files]);
  const byBase = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of paths) m.set(baseOf(p), p);
    return m;
  }, [paths]);

  const [cur, setCur] = useState(files["Home.md"] !== undefined ? "Home.md" : paths[0]);
  const [panel, setPanel] = useState<"graph" | "links" | null>("graph");
  const [switcher, setSwitcher] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // note ที่เปิดอยู่อาจหายไปตอน auto refresh (AI/คนอื่นลบ) — fallback หน้าแรกแบบ derive ไม่ต้อง sync state
  const effectiveCur =
    files[cur] !== undefined ? cur : files["Home.md"] !== undefined ? "Home.md" : paths[0];
  const note = useMemo(
    () => parseNote(effectiveCur, files[effectiveCur] ?? ""),
    [effectiveCur, files]
  );

  // backlinks: note อื่นที่ลิงก์มาหา note ปัจจุบัน + ลิงก์ออกของ note ปัจจุบัน
  const { backlinks, outlinks } = useMemo(() => {
    const base = baseOf(effectiveCur);
    const backlinks: ParsedNote[] = [];
    for (const p of paths) {
      if (p === effectiveCur) continue;
      if (parseNote(p, files[p]).links.includes(base)) backlinks.push(parseNote(p, files[p]));
    }
    const outlinks = note.links
      .map((b) => byBase.get(b))
      .filter((p): p is string => p !== undefined && p !== effectiveCur)
      .map((p) => parseNote(p, files[p]));
    return { backlinks, outlinks };
  }, [effectiveCur, files, paths, note, byBase]);

  const open = useCallback(
    (base: string) => {
      const p = byBase.get(base);
      if (p) setCur(p);
    },
    [byBase]
  );

  // Ctrl+K เปิด quick switcher
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((s) => !s);
        setQuery("");
      }
      if (e.key === "Escape") setSwitcher(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sections: Section[] = useMemo(() => {
    const colls = paths.filter((p) => p.startsWith("collections/")).sort();
    const types = paths.filter((p) => p.startsWith("types/")).sort();
    const home = paths.filter((p) => p === "Home.md");
    return [
      { key: "home", title: "หน้าหลัก", icon: "🏠", paths: home },
      { key: "collections", title: `collections (${colls.length})`, icon: "🗄", paths: colls },
      { key: "types", title: `types (${types.length})`, icon: "🧩", paths: types },
    ].filter((s) => s.paths.length > 0);
  }, [paths]);

  const switcherResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = paths.map((p) => ({ path: p, name: baseOf(p) }));
    if (!q) return all;
    return all.filter(
      (n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
    );
  }, [paths, query]);

  const itemClass = (p: string) =>
    `block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
      p === effectiveCur
        ? "bg-sky-500/15 font-medium text-sky-300"
        : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"
    }`;

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-200">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2">
        {onClose ? (
          <button
            className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="ปิดหน้า wiki"
            onClick={onClose}
          >
            ✕
          </button>
        ) : (
          <Link
            href="/"
            className="rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            title="กลับหน้าโปรเจกต์"
          >
            ←
          </Link>
        )}
        <span className="bg-gradient-to-r from-sky-400 to-violet-400 bg-clip-text font-bold text-transparent">
          📖 Wiki
        </span>
        <span className="max-w-64 truncate rounded-full border border-sky-800 bg-sky-950 px-2.5 py-0.5 text-xs text-sky-300">
          {project}
        </span>
        <span className="hidden text-xs text-slate-500 sm:block">
          {gNodes.filter((n) => n.kind === "collection").length} collections ·{" "}
          {gNodes.filter((n) => n.kind === "type").length} types · {gEdges.filter((e) => e.kind !== "contain").length} ความสัมพันธ์
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            onClick={() => setSwitcher(true)}
          >
            🔍 ค้นหา <kbd className="ml-1 rounded bg-slate-800 px-1 text-[10px]">Ctrl+K</kbd>
          </button>
          <button
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              panel === "graph"
                ? "border-sky-600 bg-sky-950 text-sky-300"
                : "border-slate-700 text-slate-400 hover:bg-slate-800"
            }`}
            onClick={() => setPanel((p) => (p === "graph" ? null : "graph"))}
          >
            🕸 กราฟ
          </button>
          <button
            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
              panel === "links"
                ? "border-violet-600 bg-violet-950 text-violet-300"
                : "border-slate-700 text-slate-400 hover:bg-slate-800"
            }`}
            onClick={() => setPanel((p) => (p === "links" ? null : "links"))}
          >
            🔗 ลิงก์
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* explorer */}
        <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-800 bg-slate-900/50 p-3">
          {sections.map((s) => (
            <div key={s.key}>
              <button
                className="mb-1 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
              >
                <span className={`inline-block transition-transform ${collapsed[s.key] ? "" : "rotate-90"}`}>
                  ▶
                </span>
                {s.icon} {s.title}
              </button>
              {!collapsed[s.key] && (
                <div className="flex flex-col gap-0.5">
                  {s.paths.map((p) => (
                    <button key={p} className={itemClass(p)} onClick={() => setCur(p)}>
                      {baseOf(p)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </aside>

        {/* เนื้อหา note */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <NoteView note={note} onOpen={open} onOpenGraph={() => setPanel("graph")} />
        </main>

        {/* panel ขวา: กราฟ / ลิงก์ */}
        {panel && (
          <aside className="flex w-[380px] shrink-0 flex-col border-l border-slate-800 bg-slate-900/40">
            {panel === "graph" ? (
              <WikiGraph gNodes={gNodes} gEdges={gEdges} activeNote={effectiveCur} onOpenNote={(p) => setCur(p)} />
            ) : (
              <div className="flex-1 overflow-y-auto p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  เชื่อมมาหา note นี้ ({backlinks.length})
                </h3>
                {backlinks.length === 0 && <div className="text-xs text-slate-600">— ไม่มี —</div>}
                <div className="mb-5 flex flex-col gap-1">
                  {backlinks.map((n) => (
                    <button key={n.path} className={itemClass(n.path)} onClick={() => setCur(n.path)}>
                      ← {n.title}
                    </button>
                  ))}
                </div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  ลิงก์ออกจาก note นี้ ({outlinks.length})
                </h3>
                {outlinks.length === 0 && <div className="text-xs text-slate-600">— ไม่มี —</div>}
                <div className="flex flex-col gap-1">
                  {outlinks.map((n, i) => (
                    <button key={`${n.path}-${i}`} className={itemClass(n.path)} onClick={() => setCur(n.path)}>
                      → {n.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* quick switcher (Ctrl+K) */}
      {switcher && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-24"
          onClick={() => setSwitcher(false)}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              className="w-full border-b border-slate-800 bg-transparent px-4 py-3 text-sm text-slate-200 outline-none placeholder:text-slate-500"
              placeholder="พิมพ์ชื่อ note…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && switcherResults[0]) {
                  setCur(switcherResults[0].path);
                  setSwitcher(false);
                }
              }}
            />
            <div className="max-h-72 overflow-y-auto p-1.5">
              {switcherResults.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-600">ไม่พบ note</div>
              )}
              {switcherResults.slice(0, 30).map((r, i) => (
                <button
                  key={r.path}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                    i === 0 ? "bg-sky-500/15 text-sky-300" : "text-slate-300 hover:bg-slate-800"
                  }`}
                  onClick={() => {
                    setCur(r.path);
                    setSwitcher(false);
                  }}
                >
                  <span className="mr-2 text-xs text-slate-500">
                    {r.path.startsWith("collections/") ? "🗄" : r.path.startsWith("types/") ? "🧩" : "🏠"}
                  </span>
                  {r.name}
                  <span className="ml-2 text-xs text-slate-600">{r.path}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
