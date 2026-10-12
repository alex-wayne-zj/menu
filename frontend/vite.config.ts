import { defineConfig } from "vite";
export default defineConfig({
  base: "/menu/",
  server: {
    proxy: {
      "/menu/api": {
        target: "http://127.0.0.1:4317",
        rewrite: (p) => p.replace(/^\/menu/, ""),
      },
    },
  },
});
