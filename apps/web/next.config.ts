import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This repo is agent-friendly by design, but generated AGENTS.md/CLAUDE.md
  // files would be noise in a controlled scaffold. Keep the tree deterministic.
  agentRules: false,
};

export default nextConfig;
