import type { NextConfig } from "next";
const nextConfig: NextConfig = { poweredByHeader: false, distDir: process.env.GTV_LOCAL_RUNTIME === '1' ? '.next-local' : '.next', experimental: { cpus: 1 }, logging: false };
export default nextConfig;
