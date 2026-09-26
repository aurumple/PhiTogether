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
            // 根组件视图来源：独立版用 DOM 模板；模块版构建（onetap/vite.onetap.config.mjs）会
            // 把它指到构建期 render 产物（隔离容器 CSP 无 unsafe-eval）。
            "app-view": path.resolve(__dirname, "src/appView.standalone.js"),
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
