import { defineConfig } from "tsdown";

const packageId = "dsh-annotation";

export default defineConfig([
  {
    name: `${packageId}/host`,
    entry: { index: "src/index.ts" },
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: (specifier: string) =>
        specifier === "@deepseek-ai/cordis" || specifier === "react",
    },
  },
  {
    name: `${packageId}/client`,
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    target: "es2024",
    fixedExtension: false,
    dts: false,
    sourcemap: true,
    clean: false,
    // React is supplied by the DSH client module table. Bundling another
    // React copy makes hooks execute against a different renderer instance.
    deps: { neverBundle: ["react"] },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
