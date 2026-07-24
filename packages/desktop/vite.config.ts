import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./", // file:// load in packaged Electron
  build: { outDir: "dist" },
  server: { port: 5183, strictPort: true },
});
