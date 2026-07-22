// mcp-stdio.ts — MCP server แบบ stdio (client spawn process แล้วคุยผ่าน stdin/stdout)
// tools ชุดเดียวกับ HTTP endpoint ทุกประการ (แชร์ app/mcp/server.ts) — แตะ data/projects.json ก้อนเดียวกัน
// รัน: npm run mcp:stdio (หรือ npx tsx mcp-stdio.ts)
// ห้าม console.log — stdout คือช่อง JSON-RPC (log ใดๆ ให้ออก stderr เท่านั้น)

import path from "path";
import { fileURLToPath } from "url";

// store หา data/projects.json จาก process.cwd() ตอน import module — บังคับ cwd = โฟลเดอร์โปรเจกต์ก่อน
// (client เช่น Claude Desktop spawn ด้วย cwd อะไรก็ได้) และต้อง chdir ก่อน dynamic import เสมอ
process.chdir(path.dirname(fileURLToPath(import.meta.url)));

async function main(): Promise<void> {
  const { createServer } = await import("./app/mcp/server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("[mongomodel-mcp] fatal:", e);
  process.exit(1);
});
