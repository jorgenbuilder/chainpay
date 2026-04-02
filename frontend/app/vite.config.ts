import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    icpBindgen({
      didFile: "../../backend/backend.did",
      outDir: "./src/backend/api",
    }),
  ],
  ...(command === "serve"
    ? {
        server: {
          headers: {
            "Set-Cookie": `ic_env=${encodeURIComponent(
              `IC_ROOT_KEY=308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c050302010361008b52b4994f94c7ce4be1c1542d7c81dc79fea17d49efe8fa42e8566373581d4b969c4a59e96a0ef51b711fe5027ec01601182519d0a788f4bfe388e593b97cd1d7e44904de79422430bca686ac8c21305b3397b5ba4d7037d17877312fb7ee34&PUBLIC_CANISTER_ID:backend=txyno-ch777-77776-aaaaq-cai`
            )}; SameSite=Lax;`,
          },
          proxy: {
            "/api": {
              target: "http://127.0.0.1:8000",
              changeOrigin: true,
            },
          },
        },
      }
    : {}),
}));
