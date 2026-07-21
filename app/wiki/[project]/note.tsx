// app/wiki/[project]/note.tsx — parser + renderer ของ note ใน wiki viewer
// parse เฉพาะรูปแบบ markdown ที่ toWiki ผลิต (frontmatter, ตาราง, ลิสต์, wikilink, mermaid)
"use client";

// ---------- parser ----------

export type Block =
  | { t: "h1" | "h2"; text: string }
  | { t: "p"; text: string }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "list"; items: string[] }
  | { t: "mermaid" };

export type ParsedNote = {
  path: string;
  name: string; // basename ไม่มี .md
  title: string;
  fm: Record<string, string>;
  tags: string[];
  blocks: Block[];
  links: string[]; // basename เป้าหมายของ wikilink ทั้งหมดใน note
};

const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** แยกเซลล์ตาราง — เคารพ \| ที่ mdEscape ใส่ไว้ */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((s) => s.trim().replace(/\\\|/g, "|"));
}

const isSepRow = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));

export function parseNote(path: string, md: string): ParsedNote {
  const name = path.replace(/\.md$/, "").split("/").pop() ?? path;
  const lines = md.split("\n");
  let i = 0;
  const fm: Record<string, string> = {};
  let tags: string[] = [];
  if (lines[0] === "---") {
    i = 1;
    while (i < lines.length && lines[i] !== "---") {
      const m = lines[i].match(/^(\w+):\s*(.*)$/);
      if (m) {
        if (m[1] === "tags") {
          const t = m[2].match(/\[(.*)\]/);
          tags = t ? t[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
        } else {
          fm[m[1]] = m[2];
        }
      }
      i++;
    }
    i++; // ข้าม --- ปิด
  }

  const blocks: Block[] = [];
  const links: string[] = [];
  const collect = (text: string) => {
    for (const m of text.matchAll(LINK_RE)) links.push(m[1]);
  };
  let title = name;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("# ")) {
      title = line.slice(2).trim() || title;
      blocks.push({ t: "h1", text: line.slice(2) });
      i++;
    } else if (line.startsWith("## ")) {
      blocks.push({ t: "h2", text: line.slice(3) });
      i++;
    } else if (line.startsWith("|")) {
      const raw: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        raw.push(splitRow(lines[i]));
        i++;
      }
      const [header, ...body] = raw;
      for (const r of raw) for (const c of r) collect(c);
      blocks.push({ t: "table", header: header ?? [], rows: body.filter((r) => !isSepRow(r)) });
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push(lines[i].slice(2));
        i++;
      }
      items.forEach(collect);
      blocks.push({ t: "list", items });
    } else if (line.startsWith("```mermaid")) {
      i++;
      while (i < lines.length && lines[i] !== "```") i++;
      i++; // ข้าม ``` ปิด
      blocks.push({ t: "mermaid" });
    } else if (line.trim() === "") {
      i++;
    } else {
      collect(line);
      blocks.push({ t: "p", text: line });
      i++;
    }
  }

  return { path, name, title, fm, tags, blocks, links };
}

// ---------- renderer ----------

/** ข้อความ inline — wikilink เป็นปุ่ม, `code` เป็นพื้นหลัง */
export function Inline({ text, onOpen }: { text: string; onOpen: (base: string) => void }) {
  const parts = text.split(/(\[\[[^\]]+\]\]|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        const clean = part.replace(/\\\|/g, "|"); // unescape \| จากตารางก่อน parse
        const link = clean.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/);
        if (link) {
          return (
            <button
              key={i}
              className="cursor-pointer rounded-md bg-sky-500/10 px-1 py-0.5 font-medium text-sky-300 transition-colors hover:bg-sky-500/25 hover:text-sky-200 hover:shadow-[0_0_12px_rgba(56,189,248,0.35)]"
              onClick={() => onOpen(link[1])}
            >
              {link[2] ?? link[1]}
            </button>
          );
        }
        const code = clean.match(/^`([^`]+)`$/);
        if (code) {
          return (
            <code key={i} className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em] text-amber-200">
              {code[1]}
            </code>
          );
        }
        return <span key={i}>{clean}</span>;
      })}
    </>
  );
}

/** แสดง note เต็ม — properties (frontmatter) + เนื้อหา */
export function NoteView({
  note,
  onOpen,
  onOpenGraph,
}: {
  note: ParsedNote;
  onOpen: (base: string) => void;
  onOpenGraph: () => void;
}) {
  const kind = note.path.startsWith("collections/")
    ? "collection"
    : note.path.startsWith("types/")
      ? "type"
      : "home";
  const icon = kind === "collection" ? "🗄" : kind === "type" ? "🧩" : "🏠";
  return (
    <article key={note.path} className="wiki-note-enter mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
        <span>{icon}</span>
        <span>{note.path.replace(/\.md$/, "").split("/").join(" / ")}</span>
      </div>
      <h1 className="mb-3 text-3xl font-bold text-slate-100">{note.title}</h1>

      {(note.fm.collection !== undefined || note.tags.length > 0) && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
          {note.fm.collection !== undefined && (
            <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
              collection: <span className="font-mono">{note.fm.collection}</span>
            </span>
          )}
          {note.tags.map((t) => (
            <span key={t} className="rounded-md bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300">
              #{t}
            </span>
          ))}
        </div>
      )}

      {note.blocks.map((b, i) => {
        if (b.t === "h1") return null; // แสดงเป็นหัวใหญ่ไปแล้ว
        if (b.t === "h2") {
          return (
            <h2 key={i} className="mb-2 mt-6 border-b border-slate-800 pb-1 text-lg font-semibold text-slate-200">
              <Inline text={b.text} onOpen={onOpen} />
            </h2>
          );
        }
        if (b.t === "p") {
          return (
            <p key={i} className="mb-3 leading-relaxed text-slate-300">
              <Inline text={b.text} onOpen={onOpen} />
            </p>
          );
        }
        if (b.t === "list") {
          return (
            <ul key={i} className="mb-4 flex flex-col gap-1.5">
              {b.items.map((item, j) => (
                <li key={j} className="flex gap-2 text-sm text-slate-300">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
                  <span>
                    <Inline text={item} onOpen={onOpen} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.t === "table") {
          return (
            <div key={i} className="mb-5 overflow-auto rounded-lg border border-slate-800">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
                    {b.header.map((h, j) => (
                      <th key={j} className="border-b border-slate-800 px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j} className="border-b border-slate-800/60 transition-colors last:border-0 hover:bg-slate-800/40">
                      {r.map((c, k) => (
                        <td key={k} className={`px-3 py-2 ${k === 0 ? "font-mono text-sky-300" : "text-slate-300"}`}>
                          <Inline text={c} onOpen={onOpen} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // mermaid → ชวนเปิดกราฟ interactive แทน
        return (
          <button
            key={i}
            onClick={onOpenGraph}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-sky-700 bg-sky-950/40 px-4 py-6 text-sm text-sky-300 transition-colors hover:border-sky-500 hover:bg-sky-950"
          >
            🕸 ดูแผนผังนี้แบบ interactive ในมุมมองกราฟ →
          </button>
        );
      })}
    </article>
  );
}
