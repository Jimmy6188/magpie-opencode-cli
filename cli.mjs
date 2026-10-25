// Finding the OpenCode CLI, asking it which free models it has, and running
// a prompt through it. The CLI is what actually talks to opencode.ai: its
// own client identity is the only thing OpenCode's free tier answers to.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ID_LINE = /^[a-z0-9][\w.-]*\/[\w][\w.-]*$/;

// Where an OpenCode install is looked for. npm's global prefix is the usual
// place on Windows; ~/.opencode/bin is where its own installer puts it.
export function candidates(env = process.env, home = os.homedir()) {
  const found = [];
  if (env.OPENCODE_BIN) found.push(env.OPENCODE_BIN);
  if (env.BUDDY_OPENCODE_PATH) found.push(env.BUDDY_OPENCODE_PATH);
  if (process.platform === "win32") {
    found.push(path.join(home, ".opencode", "bin", "opencode.exe"));
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    found.push(path.join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"));
    // npm also leaves a .cmd shim next to it; followed to the .exe it names.
    found.push(path.join(appData, "npm", "opencode.cmd"));
  } else {
    found.push(path.join(home, ".opencode", "bin", "opencode"));
    found.push("/usr/local/bin/opencode", "/opt/homebrew/bin/opencode");
  }
  return found;
}

// Only a real executable counts. On Windows, fs X_OK is granted to any
// existing file, so npm's extension-less shell shim would pass a plain
// access check and then fail to spawn; the extension is what tells them
// apart.
export function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === "win32") return /\.(exe|com)$/i.test(file);
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// npm's shim names the executable it wraps. Read it rather than spawn it:
// Node refuses to spawn a .cmd directly, and going through a shell would
// mangle a prompt full of newlines and quotes.
function resolveShim(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/"([^"]*node_modules[^"]*\.exe)"/i);
    if (!match) return null;
    const target = match[1].replace(/%dp0%/gi, path.dirname(file));
    return isExecutable(target) ? target : null;
  } catch {
    return null;
  }
}

export function findOpencode(env = process.env, home = os.homedir()) {
  const names = process.platform === "win32" ? ["opencode.exe"] : ["opencode"];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  for (const file of candidates(env, home)) {
    if (!file) continue;
    if (isExecutable(file)) return file;
    const target = resolveShim(file);
    if (target) return target;
  }
  return null;
}

function run(bin, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`opencode ${args[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

export async function version(bin) {
  const out = await run(bin, ["--version"], { timeout: 20_000 });
  return out.trim().replace(/^opencode\s+v?/i, "");
}

// `opencode models --verbose` prints one `provider/id` line followed by that
// model's JSON, for every model the CLI can use.
export function parseVerbose(text) {
  const models = [];
  let id = null;
  let buffer = [];
  const flush = () => {
    if (id && buffer.length) {
      try {
        models.push({ key: id, ...JSON.parse(buffer.join("\n")) });
      } catch {
        // A block that will not parse is skipped; the rest still loads.
      }
    }
    id = null;
    buffer = [];
  };
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (ID_LINE.test(trimmed)) {
      flush();
      id = trimmed;
      continue;
    }
    if (id) buffer.push(line);
  }
  flush();
  return models;
}

export function isFreeModel(model) {
  return (
    model?.providerID === "opencode" &&
    model.status !== "deprecated" &&
    model.cost &&
    model.cost.input === 0 &&
    model.cost.output === 0
  );
}

export async function listModels(bin) {
  const out = await run(bin, ["models", "--verbose"], { timeout: 60_000 });
  return parseVerbose(out).filter(isFreeModel);
}

// A directory of its own, so the CLI does not treat whatever directory the
// plugin host happens to run in as the project.
export function workDir(env = process.env) {
  const dir = path.join(env.BUDDY_DATA_DIR ?? path.join(os.tmpdir(), "magpie-opencode-cli"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Runs one prompt and yields the CLI's JSON events as they arrive.
export async function* runPrompt(bin, model, prompt, signal) {
  const child = spawn(
    bin,
    ["run", "--format", "json", "-m", `opencode/${model}`, prompt],
    { cwd: workDir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const failures = [];
  child.stderr?.on("data", (d) => (stderr += d));
  child.on("error", (error) => failures.push(error));
  // Registered before stdout is read: `close` can fire while the loop is still
  // running, and a listener added afterwards would never be called.
  const exited = new Promise((resolve) => child.on("close", resolve));

  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Not every line the CLI prints is JSON; the rest are skipped.
      }
    }
    const code = await exited;
    if (failures.length) throw failures[0];
    if (code !== 0) {
      throw new Error(
        `opencode run exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`,
      );
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    lines.close();
    child.kill();
  }
}
