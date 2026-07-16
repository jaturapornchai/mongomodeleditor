"use client"; // Error boundary ต้องเป็น Client Component

import { useEffect } from "react";

// safety net ระดับแอป — กัน uncaught render error ทำทั้งหน้าล่มแบบกู้ไม่ได้
// (ข้อมูลอยู่ใน localStorage — retry จะโหลด state ล่าสุดที่บันทึกไว้กลับมา)
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-950 text-slate-200">
      <h2 className="text-lg font-semibold">เกิดข้อผิดพลาดที่ไม่คาดคิด</h2>
      <p className="max-w-md text-center text-sm text-slate-400">
        งานที่บันทึกล่าสุดยังอยู่ในเครื่อง — กดลองใหม่เพื่อโหลดกลับมา
      </p>
      <button
        className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600"
        onClick={() => unstable_retry()}
      >
        ลองใหม่
      </button>
    </div>
  );
}
