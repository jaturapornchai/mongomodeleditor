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
  return (
    <html lang="th" className={`${notoThai.variable} h-full antialiased`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
