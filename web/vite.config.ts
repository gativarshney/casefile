import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    // The API binds loopback IPv4 only. "localhost" resolves to ::1 first on Windows
    // and modern Node, which the proxy does not fall back from, so target the address
    // the server actually listens on.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
