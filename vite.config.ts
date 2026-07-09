import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
// Derive the Pages base from the repo name in CI (GITHUB_REPOSITORY is
// "owner/repo"), so renaming the repo can't break asset paths. Falls back to
// the known name for local `build:pages` runs.
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const pagesBase = `/${repo ?? "blind-pirate-trader"}/`;

export default defineConfig({
  base: isGitHubPages ? pagesBase : "/",
  // Expose VICMET_BASE from .env to the browser (Vite's default is VITE_ only).
  envPrefix: ["VITE_", "VICMET_"],
  css: {
    transformer: "lightningcss",
  },
  resolve: {
    alias: {
      "@": `${process.cwd()}/src`,
    },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      server: { entry: "server" },
      ...(isGitHubPages && {
        spa: {
          enabled: true,
          prerender: {
            outputPath: "/index.html",
          },
        },
      }),
      importProtection: {
        behavior: "error",
        client: {
          files: ["**/server/**"],
          specifiers: ["server-only"],
        },
      },
    }),
    nitro(),
    viteReact(),
  ],
});
