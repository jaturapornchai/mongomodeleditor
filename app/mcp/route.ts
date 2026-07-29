// app/mcp/route.ts — MCP endpoint แบบ Streamable HTTP (stateless, POST เท่านั้น)
// AI ภายนอกเชื่อมที่ http://localhost:3100/mcp แล้วอ่าน/เพิ่ม/ลบ/แก้ไข diagram ได้ครบ
// tools ทั้งหมดนิยามใน app/mcp/server.ts (แชร์กับ mcp-stdio.ts — transport แบบ stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server";

export const runtime = "nodejs";

// ---------- route handler (stateless เหมือนเดิม + server pool) ----------
// วัดจริง createServer ~1.1ms/call (1000 ครั้ง) — pool ลดต้นทุนสร้าง server ซ้ำทุก request
// connect ซ้ำหลัง close ได้เอง: transport.close() เรียก onclose → Protocol._onclose ล้าง _transport ให้
// (อัปเกรด SDK เมื่อไรให้ยิง POST /mcp ซ้ำหลายครั้งตรวจว่าไม่เจอ "Already connected to a transport")
const POOL_SIZE = 8;
const serverPool: McpServer[] = [];
const checkout = (): McpServer => serverPool.pop() ?? createServer();
const checkin = async (server: McpServer): Promise<void> => {
  try {
    await server.close(); // ปิด transport ของ request นี้
  } catch {
    // ปิดซ้ำ/ปิดตอนยังไม่ connect ได้ ไม่เป็นไร
  }
  if (serverPool.length < POOL_SIZE) serverPool.push(server);
};

async function handle(req: Request): Promise<Response> {
  // endpoint นี้ไม่มี auth — กัน blind CSRF จากเว็บที่ผู้ใช้เปิดค้าง: เบราว์เซอร์แนบ Origin เสมอ
  // มี Origin แต่ host ไม่ตรงปลายทาง → 403; ไม่มี Origin = MCP client ปกติ ปล่อยผ่าน (ห้ามเข้มกว่านี้)
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Origin เพี้ยน/เป็น "null" (opaque origin ของ sandbox) → ไม่ผ่าน
    }
    if (originHost === null || originHost !== req.headers.get("host")) {
      return new Response(`[FORBIDDEN_ORIGIN] ปฏิเสธ request ข้าม origin (${origin})`, {
        status: 403,
      });
    }
  }
  const server = checkout(); // sync — 2 request ขนานได้คนละ instance แน่นอน (ไม่ cross-talk)
  try {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — ไม่ต้องจัดการ session
      enableJsonResponse: true, // ตอบเป็น JSON เลย ไม่ต้องเปิด SSE stream
    });
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    await checkin(server);
  }
}

export const POST = handle;
