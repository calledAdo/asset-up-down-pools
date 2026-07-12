import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// CCC uses BigInt and targets modern browsers. Split the heavy wallet/react
// vendors out of the app chunk so the initial app payload stays small.
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    // The CCC wallet stack is ~550 KB and can't be shrunk; it's isolated in its
    // own cached chunk, so lift the warning above it.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          ccc: ["@ckb-ccc/connector-react", "@ckb-ccc/core"],
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  server: { port: 5173 },
});
