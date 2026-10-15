import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build lands in web/dist and is served by openminis-server at "/".
// `npm run dev` proxies API calls to a server running on :8787.
const api = "http://127.0.0.1:8787";
const routes = ["roles", "tasks", "channels", "approvals", "routines", "triggers", "connectors", "notifiers", "usage", "audit", "events", "health"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: Object.fromEntries(routes.map((r) => [`/${r}`, api])) },
});
