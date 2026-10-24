import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"

const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
})
