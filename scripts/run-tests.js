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

// `--test-concurrency=1`: several of the fuzz/differential test FILES each
// cap their own real-subprocess pool at `min(4, cpus)` (see
// fuzzHarness.ts's `POOL_SIZE_DEFAULT`) specifically to bound how many
// concurrent `sh`/`git`/`awk` processes one file's fuzz cases put in
// flight. Node's test runner, left at its default, still runs multiple
// test FILES concurrently -- which stacks several files' pools on top of
// each other and reproduces the exact contention the per-file cap was
// meant to prevent (a `git rev-parse` failing transiently under load,
// correctly reported by the evaluator as `inspection-failed`, but read as
// a spurious mismatch by a harness expecting a policy verdict). Observed
// directly: an intermittent failure at roughly 1-in-3 runs with default
// file-level concurrency, gone across repeated runs once serialized.
// Sub-tests within one file are unaffected -- this only removes the
// additional, unbounded layer of cross-file parallelism.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
