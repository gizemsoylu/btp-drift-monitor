#!/usr/bin/env node
// Transpiles the UI5 app's TypeScript sources (webapp/**/*.ts) into sibling .js files
// using the same Babel pipeline ui5-tooling-transpile uses (@babel/preset-typescript +
// babel-preset-transform-ui5, which turns ES module import/export into sap.ui.define()).
// Run via `npm run build:app` (wired as a pre-step of `start`/`watch`).
"use strict";

const path = require("path");
const fs = require("fs");
const babel = require("@babel/core");

const WEBAPP_DIR = path.join(__dirname, "..", "app", "destination-drift", "webapp");

function collectTsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function build() {
  const files = collectTsFiles(WEBAPP_DIR);
  for (const file of files) {
    const result = babel.transformFileSync(file, {
      presets: [
        [require.resolve("@babel/preset-typescript"), { onlyRemoveTypeImports: true }],
        [require.resolve("babel-preset-transform-ui5"), { transformModulesToUI5: true }],
      ],
      filename: file,
      sourceMaps: "inline",
    });

    const outFile = file.replace(/\.ts$/, ".js");
    fs.writeFileSync(outFile, result.code, "utf-8");
    console.log(`built ${path.relative(WEBAPP_DIR, outFile)}`);
  }
}

build();
