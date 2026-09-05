import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 47193,
    strictPort: true,
    warmup: {
      clientFiles: ["./src/main.ts", "./src/bubble.ts"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 47193,
    strictPort: true,
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        bubble: resolve(root, "bubble.html"),
      },
    },
  },
});
