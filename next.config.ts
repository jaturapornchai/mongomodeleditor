import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // สำหรับ Docker: ผลิต .next/standalone (server.js + node_modules เท่าที่จำเป็น) ให้ image เล็ก
  output: "standalone",
};

export default nextConfig;
