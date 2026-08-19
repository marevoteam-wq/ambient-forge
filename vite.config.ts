import { defineConfig } from "vite";

export default defineConfig({
  server: {
    cors: true,
  },
  optimizeDeps: {
    exclude: ["@owlbear-rodeo/sdk"],
    include: ["events"],
  },
  build: {
    rollupOptions: {
      input: { panel: "index.html", background: "background.html" },
    },
  },
});

