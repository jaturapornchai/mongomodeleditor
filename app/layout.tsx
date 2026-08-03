import type { Metadata } from "next";
import { Noto_Sans_Thai } from "next/font/google";
import "./globals.css";

const notoThai = Noto_Sans_Thai({
  variable: "--font-noto-thai",
  subsets: ["thai", "latin"],
});

export const metadata: Metadata = {
  title: "MongoModel — ออกแบบโครงสร้างข้อมูล",
  description: "เครื่องมือออกแบบ Data Model สำหรับ MongoDB ลากวาง เชื่อมความสัมพันธ์ นำเข้า/ส่งออก JSON",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // ตั้งธีมก่อน hydrate — hook ธีมเดิมอยู่ใน page.tsx ตัวเดียว route /wiki/<project> จึงไม่มีใคร
  // เขียน data-theme ให้ คนที่ใช้โหมดสว่างเปิดลิงก์ wiki แล้วได้หน้าดำทุกครั้ง (และหน้าแรกกระพริบดำ)
  const themeBoot = `try{var t=localStorage.getItem("mongomodel-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}catch(e){}`;
  return (
    // suppressHydrationWarning — สคริปต์ข้างล่างเขียน data-theme/color-scheme ลง <html> ก่อน hydrate
    // (ตั้งใจให้ต่างจาก HTML ที่ server ส่งมา) ไม่งั้น react เตือน hydration mismatch ทุกครั้งที่โหลด
    <html lang="th" suppressHydrationWarning className={`${notoThai.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
