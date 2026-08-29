#!/usr/bin/env node
/**
 * ZCode hook -> Discord Rich Presence state updater.
 *
 * Reads one hook event JSON from stdin, derives a short presence message,
 * writes it into the shared state file and makes sure the RPC daemon
 * (bin/rpc-daemon.mjs) is running. The daemon owns the actual connection
 * to Discord's local IPC socket.
 *
 * Contract notes:
 * - stdout must stay empty: the hook runner validates stdout as strict JSON.
 * - exit code 2 would block tool calls, so this script always exits 0.
 * - tool_input contents are never forwarded (may contain secrets).
 *
 * Manual smoke test:
 *   printf '%s\n' '{"hook_event_name":"PreToolUse","session_id":"t1","cwd":"/tmp/proj","tool_name":"Bash"}' \
 *     | node hooks/rpc-hook.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "zcode-discord-rpc";
const STATE_VERSION = 1;

const DEFAULT_CONFIG = {
    client_id: "",
    large_image_key: "zcode",
    large_image_text: "ZCode CLI",
    small_image_key: "",
    show_prompt: true,
    max_prompt_len: 80,
    idle_timeout_min: 60,
};

const TOOL_VERBS = {
    Bash: "Running a shell command",
    Edit: "Editing a file",
    Write: "Writing a file",
    ApplyPatch: "Applying a patch",
    Read: "Reading a file",
    Grep: "Searching code",
    Glob: "Searching files",
    WebFetch: "Fetching a web page",
    WebSearch: "Searching the web",
    Agent: "Running a subagent",
    Task: "Running a subagent",
    TodoWrite: "Updating the todo list",
    NotebookEdit: "Editing a notebook",
    Skill: "Invoking a skill",
    KillShell: "Stopping a background task",
    TaskOutput: "Reading task output",
};

const log = (msg) => process.stderr.write(`[${PLUGIN_NAME}] ${msg}\n`);

function resolveDirs() {
    const override = (process.env.ZCODE_DISCORD_RPC_DIR || "").trim();
    if (override) {
        return [override, override];
    }
    if (process.platform === "win32") {
        const configRoot = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        const cacheRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return [path.join(configRoot, PLUGIN_NAME), path.join(cacheRoot, PLUGIN_NAME)];
    }
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    return [path.join(configRoot, PLUGIN_NAME), path.join(cacheRoot, PLUGIN_NAME)];
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function writeJsonIfChanged(filePath, data) {
    try {
        if (readJson(filePath) && JSON.stringify(readJson(filePath)) === JSON.stringify(data)) {
            return;
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
    } catch (exc) {
        log(`cannot write ${path.basename(filePath)}: ${exc.message}`);
    }
}

function truncate(text, limit) {
    const flat = text.split(/\s+/).filter(Boolean).join(" ");
    if (flat.length <= limit) return flat;
    return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function daemonAlive(pidFile) {
    let pid = NaN;
    try {
        pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
        return false;
    }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (exc) {
        if (exc.code === "EPERM") return true; // exists, owned by someone else
        try {
            fs.unlinkSync(pidFile);
        } catch { /* already gone */ }
        return false;
    }
}

function ensureDaemon(runtimeDir) {
    const pidFile = path.join(runtimeDir, "daemon.pid");
    if (daemonAlive(pidFile)) return;
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "rpc-daemon.mjs");
    try {
        fs.mkdirSync(runtimeDir, { recursive: true });
        const out = fs.openSync(path.join(runtimeDir, "daemon.log"), "a");
        const child = spawn(process.execPath, [script, runtimeDir], {
            detached: true,
            stdio: ["ignore", out, out],
            env: process.env,
        });
        child.unref();
        fs.closeSync(out);
    } catch (exc) {
        log(`cannot spawn daemon: ${exc.message}`);
    }
}

function activityFor(event, payload, config) {
    const cwd = payload.cwd || process.cwd();
    const project = path.basename(cwd) || cwd;
    const details = `Working on ${project}`;

    if (event === "SessionStart") {
        const source = payload.source || "startup";
        const text = {
            startup: "Ready to code",
            resume: "Session resumed",
            clear: "Session cleared",
            compact: "Session compacted",
        }[source] ?? "Ready to code";
        return { reset: true, state: "idle", text, details };
    }

    if (event === "UserPromptSubmit") {
        if (config.show_prompt !== false) {
            const prompt = String(payload.prompt || payload.user_prompt || "");
            const firstLine = prompt.split("\n").find((l) => l.trim().length > 0) ?? "";
            if (firstLine) {
                const limit = Number(config.max_prompt_len) || 80;
                return { state: "working", text: truncate(firstLine, limit), details };
            }
        }
        return { state: "working", text: "Thinking…", details };
    }

    if (event === "PreToolUse") {
        const tool = String(payload.tool_name || payload.toolName || "").trim();
        return { state: "working", text: TOOL_VERBS[tool] ?? `Using ${tool || "a tool"}`, details };
    }

    if (event === "PostToolUseFailure") {
        const tool = String(payload.tool_name || payload.toolName || "").trim();
        return { state: "working", text: `Fixing an error from ${tool || "a tool"}`, details };
    }

    if (event === "PermissionRequest") {
        const tool = String(payload.tool_name || payload.toolName || "").trim();
        return { state: "working", text: `Waiting for permission: ${tool || "action"}`, details };
    }

    if (event === "Stop") {
        return { state: "idle", text: "Waiting for your input", details };
    }

    return null;
}

function fingerprint(entry) {
    return [entry.session_id, entry.started_at, entry.state, entry.text, entry.details].join("\u0000");
}

async function main() {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    let payload = {};
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        log("invalid JSON on stdin, ignoring event");
        return;
    }

    const event = String(payload.hook_event_name || payload.hookEventName || "");
    if (!event) return;

    const [configDir, runtimeDir] = resolveDirs();
    const configPath = path.join(configDir, "config.json");
    let config = readJson(configPath);
    if (!config || typeof config !== "object") config = {};
    if (!fs.existsSync(configPath)) {
        writeJsonIfChanged(configPath, { ...DEFAULT_CONFIG });
    }

    try {
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.appendFileSync(
            path.join(runtimeDir, "hook-trace.log"),
            `${new Date().toTimeString().slice(0, 8)} ${event} ${payload.tool_name || ""} sid=${payload.session_id}\n`,
        );
    } catch { /* tracing is best-effort */ }

    const activity = activityFor(event, payload, config);
    if (!activity) return;

    const state = readJson(path.join(runtimeDir, "state.json")) ?? {};
    const sessionId = String(payload.session_id || state.session_id || "");
    const now = Date.now() / 1000;
    const startedAt =
        activity.reset || !sessionId || sessionId !== String(state.session_id || "")
            ? Math.floor(now)
            : Math.floor(Number(state.started_at) || now);

    const newState = {
        version: STATE_VERSION,
        session_id: sessionId,
        started_at: startedAt,
        state: activity.state,
        text: activity.text,
        details: activity.details,
        ts: now,
    };

    ensureDaemon(runtimeDir);
    if (fingerprint(newState) !== fingerprint(state)) {
        writeJsonIfChanged(path.join(runtimeDir, "state.json"), newState);
    }
}

main().then(
    () => process.exit(0),
    (exc) => {
        log(`unexpected error: ${exc?.stack || exc}`);
        process.exit(0); // presence must never break a session
    },
);
