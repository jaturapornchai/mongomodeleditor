// app/mcp/route.ts — MCP endpoint แบบ Streamable HTTP (stateless, POST เท่านั้น)
// AI ภายนอกเชื่อมที่ http://localhost:3100/mcp แล้วอ่าน/เพิ่ม/ลบ/แก้ไข diagram ได้ครบ
// tools ทั้งหมดนิยามใน app/mcp/server.ts (แชร์กับ mcp-stdio.ts — transport แบบ stdio)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server";

export const runtime = "nodejs";

// ---------- route handler (stateless เหมือนเดิม + server pool) ----------
// วัดจริง createServer ~1.1ms/call (1000 ครั้ง) — pool ลดต้นทุนสร้าง server ซ้ำทุก request
// ข้อจำกัด SDK 1.29: Protocol.connect() ไม่ยอม connect ซ้ำหลัง close เพราะไม่ล้าง this._transport
// → ต้องล้างเอง (ผูกกับเวอร์ชัน SDK ที่ lockfile pin ไว้ — อัปเกรด SDK ให้ตรวจจุดนี้ใหม่)
const POOL_SIZE = 8;
const serverPool: McpServer[] = [];
const checkout = (): McpServer => serverPool.pop() ?? createServer();
const checkin = async (server: McpServer): Promise<void> => {
  try {
    await server.close(); // ปิด transport ของ request นี้
  } catch {
    // ปิดซ้ำ/ปิดตอนยังไม่ connect ได้ ไม่เป็นไร
  }
  (server as unknown as { _transport?: unknown })._transport = undefined;
  if (serverPool.length < POOL_SIZE) serverPool.push(server);
};

async function handle(req: Request): Promise<Response> {
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
