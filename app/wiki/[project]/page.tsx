// app/wiki/[project]/page.tsx — หน้า wiki viewer (server component: เตรียมข้อมูลจาก store ทุกครั้ง)
import Link from "next/link";
import { getWikiData } from "../../wiki-data";
import WikiViewer from "./WikiViewer";

export const dynamic = "force-dynamic"; // อ่านข้อมูลล่าสุดจาก data/projects.json ทุกครั้งที่เปิด

export default async function WikiPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const data = await getWikiData(decodeURIComponent(project));
  if (!data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-300">
        <div className="text-4xl">🗂️</div>
        <div>
          ไม่พบโปรเจกต์ <span className="font-mono text-sky-300">{decodeURIComponent(project)}</span>
        </div>
        <Link href="/" className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800">
          ← กลับหน้าโปรเจกต์
        </Link>
      </div>
    );
  }
  return <WikiViewer data={data} />;
}
