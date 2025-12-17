import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"]
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
