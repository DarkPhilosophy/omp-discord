#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ignoredDirectories = new Set([".git", "node_modules"]);
const ignoredFiles = new Set(["bun.lock"]);
const rules = [
  {
    name: "Discord token",
    pattern: /(?:mfa\.)[A-Za-z0-9_-]{20,}|(?:[A-Za-z0-9_-]{24}\.){2}[A-Za-z0-9_-]{20,}/g,
  },
  { name: "private key", pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/g },
];
const findings = [];

function scan(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry) || ignoredFiles.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      scan(path);
      continue;
    }
    if (!stat.isFile()) continue;
    const content = readFileSync(path, "utf8");
    for (const rule of rules) {
      for (const match of content.matchAll(rule.pattern)) {
        const line = content.slice(0, match.index).split("\n").length;
        findings.push(`${relative(root, path)}:${line} — ${rule.name}`);
      }
    }
  }
}

scan(root);
if (findings.length) {
  console.error(`scan-leaks: ${findings.length} finding(s)`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}
console.log("scan-leaks: clean");
