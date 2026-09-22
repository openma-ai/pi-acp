import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    bin: "src/bin.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: true,
  minify: false,
  // pi and the ACP SDK stay external: sessions, extensions, and credential stores must
  // share one module identity with the installed pi package.
  external: [/^@earendil-works\//, /^@agentclientprotocol\//, "typebox"],
});
