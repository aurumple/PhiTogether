import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
            "@utils": path.resolve(__dirname, "src/utils"),
            "@components": path.resolve(__dirname, "src/components"),
            "@locales": path.resolve(__dirname, "src/locales"),
            "@renderers": path.resolve(__dirname, "src/components/renderer/renderers"),
        },
    },
    build: {
        cssTarget: "chrome61",
        esbuild: {
            drop: ["console", "debugger"],
        },
    },
    server: {
        // Dev: forward API calls to the self-hosted server (`python server/main.py`)
        proxy: {
            "/api": "http://127.0.0.1:8000",
        },
    },
    preview: {
        port: 1443,
    },
});
