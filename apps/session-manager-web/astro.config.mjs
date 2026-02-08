import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  output: "server",
  adapter: node({
    mode: "standalone",
  }),
  server: {
    host: "127.0.0.1",
    port: 4321,
    allowedHosts: ["suyashs-mac-mini.taildd10d7.ts.net"]
  },
});
