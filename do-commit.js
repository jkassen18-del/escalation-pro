#!/usr/bin/env node
// One-shot commit helper - runs outside VS Code's environment context
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const repo = "C:\\Users\\Jamal\\Documents\\escalation-pro";
const gitExe = "C:\\Program Files\\Git\\cmd\\git.exe";
const msg = "feat: docker + postgres sql backend + render cloud deployment";

function run(args, label) {
  try {
    const out = execFileSync(gitExe, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`[${label}] OK`, out.trim());
    return true;
  } catch (e) {
    console.error(`[${label}] FAILED (exit ${e.status}):`, e.stderr || e.message);
    return false;
  }
}

// Remove stale lock
const lockPath = path.join(repo, ".git", "index.lock");
if (fs.existsSync(lockPath)) {
  fs.unlinkSync(lockPath);
  console.log("Removed stale index.lock");
}

if (!run(["add", "-A"], "git add")) process.exit(1);
if (!run(["commit", "-m", msg], "git commit")) process.exit(1);
run(["log", "--oneline", "-3"], "git log");
