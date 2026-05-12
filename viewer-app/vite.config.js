import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { runReportPlugin } from "./plugins/runReportPlugin.js";

export default defineConfig({
  plugins: [react(), runReportPlugin()],
});
