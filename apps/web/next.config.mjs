/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them itself.
  transpilePackages: [
    "@hd/core",
    "@hd/llm",
    "@hd/rag",
    "@hd/tools",
    "@hd/agent-helpdesk",
  ],
  // Node-native libraries: leave them to Node's require rather than bundling.
  // Bundling bullmq also drags in its optional valkey client, which is not
  // installed and produces a resolve warning on every build.
  serverExternalPackages: ["bullmq", "ioredis", "pg", "mailparser"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  webpack: (config) => {
    // The workspace packages use ESM-style `./thing.js` specifiers that point
    // at TypeScript source. Node and tsx resolve those; webpack needs telling.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
