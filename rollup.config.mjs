import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

/* One source file (see the note at the top of src/index.ts), built twice:
   CommonJS and ESM, as the other @ecosy packages are. No UMD build — this
   runs on a server, against node:crypto and Paddle's Node SDK, and has
   nothing to offer a browser. */
const input = { index: "src/index.ts" };

/* The SDK is a peer: the app's copy is the one used. */
const external = ["@paddle/paddle-node-sdk", /^node:/];

// Minification configuration, as in @ecosy/core.
const minifyOptions = {
  compress: {
    drop_console: ["log", "info", "debug"],
    drop_debugger: true,
    pure_funcs: ["console.log", "console.info", "console.debug"],
  },
  mangle: true,
};

// CommonJS build
const cjsConfig = {
  input,
  external,
  output: {
    dir: "dist",
    format: "cjs",
    entryFileNames: "[name].js",
    exports: "named",
    interop: "auto",
  },
  plugins: [
    typescript({ tsconfig: "./tsconfig.json", declaration: true, declarationDir: "dist", rootDir: "src" }),
    terser(minifyOptions),
  ],
};

// ESM build
const esmConfig = {
  input,
  external,
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].mjs",
    exports: "named",
    interop: "auto",
    generatedCode: { symbols: true },
  },
  plugins: [
    typescript({ tsconfig: "./tsconfig.json", declaration: false, declarationDir: undefined, rootDir: "src" }),
    terser(minifyOptions),
  ],
};

export default [cjsConfig, esmConfig];
