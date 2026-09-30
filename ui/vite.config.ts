import fs from "node:fs"
import os from "node:os"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// In `vite dev`, talk to the running servedev daemon through a proxy.
const home = process.env.SERVEDEV_HOME ?? path.join(os.homedir(), ".servedev")
const daemonPort = process.env.SERVEDEV_PORT ?? "7777"
let devToken = ""
try {
  devToken = fs.readFileSync(path.join(home, "token"), "utf8").trim()
} catch {
  // daemon has never run; API calls will fail until it does
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // The production build is a single self-contained index.html that the daemon embeds.
  plugins: [react(), tailwindcss(), viteSingleFile()],
  define: {
    __DEV_TOKEN__: JSON.stringify(command === "serve" ? devToken : ""),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (req) => req.removeHeader("origin")),
      },
    },
  },
}))
