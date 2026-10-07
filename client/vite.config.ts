import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { DEV_API_PORT, DEV_CLIENT_PORT } from "./src/lib/dev-ports";

/** Cookies are per-host; keep dev on 127.0.0.1 so login and /api/auth/me share sf_token. */
function canonicalDevHost(): Plugin {
  return {
    name: "canonical-dev-host",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const host = req.headers.host ?? "";
        if (host.startsWith("localhost:")) {
          res.writeHead(302, {
            Location: `http://127.0.0.1:${host.split(":")[1] ?? String(DEV_CLIENT_PORT)}${req.url ?? "/"}`,
          });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

const apiTarget = `http://127.0.0.1:${DEV_API_PORT}`;

export default defineConfig({
  plugins: [
    canonicalDevHost(),
    react(),
    tailwindcss(),
    VitePWA({
      devOptions: { enabled: false },
      registerType: "autoUpdate",
      includeAssets: ["icons/favicon.svg", "icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Society Finance",
        short_name: "Society",
        description: "Member savings and lending for a society",
        theme_color: "#0c3d2c",
        background_color: "#e7efe9",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/, /^\/uploads/],
      },
    }),
  ],
  server: {
    host: "0.0.0.0",
    port: DEV_CLIENT_PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const raw = proxyRes.headers["set-cookie"];
            if (!raw) return;
            const list = Array.isArray(raw) ? raw : [raw];
            proxyRes.headers["set-cookie"] = list.map((header) =>
              header.replace(/;\s*Secure/gi, "").replace(/;\s*Domain=[^;]+/gi, ""),
            );
          });
        },
      },
      "/uploads": {
        target: apiTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
