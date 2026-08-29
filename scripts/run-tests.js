#!/usr/bin/env node
// Cross-platform test runner for `npm test`.
//
// Phase 7 finding: neither shell glob expansion nor Node's own --test
// glob support can be relied on across the three CI platforms this
// project now runs on. `node --test out/test/*.js` silently ran ZERO
// tests on windows-latest (pwsh does not glob-expand an argument to an
// external command the way bash does -- node received the literal string
// "out/test/*.js"). Quoting the glob and letting Node's --test glob
// engine expand it internally ("out/test/**/*.test.js") worked locally
// (Node 22) but failed the same way on a real ubuntu-latest/macos-latest
// runner running Node 24 -- glob support inside --test is apparently not
// consistent enough across Node versions to depend on either.
//
// This sidesteps both: plain Node `fs.readdirSync`, no shell involved, no
// --test glob syntax involved -- just an explicit file list handed to
// `node --test`, which every platform/Node version supports identically.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const testDir = path.join(__dirname, "..", "out", "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`No compiled test files found in ${testDir} -- did "npm run compile" run first?`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
