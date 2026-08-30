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
const STATE_VERSION = 2;

// Seeded on first run as a commented config so every field is discoverable.
// Full-line // comments are allowed anywhere in the config file.
const CONFIG_TEMPLATE = `// zcode-discord-rpc configuration.
// Full-line "//" comments are allowed. Changes hot-reload (a few seconds).
//
// AVAILABLE VARIABLES for the templates below:
//   {project} — current workspace folder name
//   {prompt}  — first line of your last prompt (hidden when show_prompt is false)
//   {tool}    — what the agent is doing with tools right now, e.g. "Running a shell command"
//   {task}    — current in-progress task name from the todo list
//   {auto}    — the built-in smart status (prompt -> tool -> idle text)
// If a template renders empty, fallback_text is used instead.
{
    // Discord application id shown as the "playing ..." title.
    // Empty = the plugin's built-in shared application (zero-setup default).
    "client_id": "",

    // Line 1 (top) of the presence.
    "details_template": "Working on {project}",

    // Line 2 (bottom) of the presence.
    // "{auto}" keeps the classic behavior; use "{tool}" or static text to hide your prompt.
    "state_template": "{auto}",

    // Used when a template renders empty (e.g. "{prompt}" with no prompt yet).
    "fallback_text": "ZCode",

    // Name of the art asset uploaded in your Discord application for the big icon.
    "large_image_key": "apple-icon",
    "large_image_text": "ZCode",

    // Small icon asset name; empty = hidden.
    "small_image_key": "",

    // Show the first line of your prompt as part of the status.
    "show_prompt": true,

    // Prompt preview length limit (characters).
    "max_prompt_len": 80,

    // Minutes without activity before the presence is cleared.
    "idle_timeout_min": 60
}
`;

const DEFAULT_CONFIG = {
    client_id: "", // empty = built-in shared application (zero-setup default)
    details_template: "Working on {project}",
    state_template: "{auto}",
    fallback_text: "ZCode",
    large_image_key: "apple-icon",
    large_image_text: "ZCode",
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
        // full-line "//" comments are allowed in config files
        const cleaned = fs
            .readFileSync(filePath, "utf8")
            .split("\n")
            .filter((line) => !/^\s*\/\//.test(line))
            .join("\n");
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

function writeTextIfChanged(filePath, contents) {
    try {
        if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === contents) return;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, contents);
        fs.renameSync(tmp, filePath);
    } catch (exc) {
        log(`cannot write ${path.basename(filePath)}: ${exc.message}`);
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

function firstLine(text) {
    return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
}

function substitute(template, vars) {
    return template
        .replace(/\{project\}/g, vars.project)
        .replace(/\{prompt\}/g, vars.prompt)
        .replace(/\{tool\}/g, vars.tool)
        .replace(/\{task\}/g, vars.task)
        .replace(/\{auto\}/g, vars.auto)
        .replace(/\s+/g, " ")
        .trim();
}

function buildPresence(event, payload, config, prevState) {
    const cwd = payload.cwd || process.cwd();
    const project = path.basename(cwd) || cwd;
    const toolName = String(payload.tool_name || payload.toolName || "").trim();
    const limit = Number(config.max_prompt_len) || 80;

    // dynamic variable values for this event; {auto} = the classic smart status
    let prompt = config.show_prompt === false ? "" : String(prevState.prompt || "");
    let tool = String(prevState.tool || "");
    let task = truncate(String(prevState.task || ""), limit);
    let auto = "";
    let idle = false;

    // {task}: the current in-progress todo, taken from TodoWrite updates
    if (toolName === "TodoWrite") {
        const todos = Array.isArray(payload.tool_input?.todos) ? payload.tool_input.todos : [];
        const current = todos.find((t) => t?.status === "in_progress") ?? todos.find((t) => t?.status !== "completed");
        task = current?.content ? truncate(String(current.content), limit) : task;
    }

    switch (event) {
        case "SessionStart":
            // keep {task} across sessions: you are still "in" that task
            prompt = "";
            tool = "";
            auto = task || "Ready to code";
            idle = true;
            break;
        case "UserPromptSubmit": {
            prompt =
                config.show_prompt === false
                    ? ""
                    : truncate(firstLine(String(payload.prompt || payload.user_prompt || "")), limit);
            tool = "";
            auto = prompt || "Thinking…";
            break;
        }
        case "PreToolUse":
            tool = TOOL_VERBS[toolName] ?? `Using ${toolName || "a tool"}`;
            auto = tool;
            break;
        case "PostToolUseFailure":
            tool = `Fixing an error from ${toolName || "a tool"}`;
            auto = tool;
            break;
        case "PermissionRequest":
            tool = `Waiting for permission: ${toolName || "action"}`;
            auto = tool;
            break;
        case "Stop":
            tool = "";
            auto = task || "Waiting for your input";
            idle = true;
            break;
        default:
            return null;
    }

    const vars = { project, prompt, tool, task, auto };
    const fallback = String(config.fallback_text || "ZCode");
    const details = substitute(String(config.details_template ?? "Working on {project}"), vars) || fallback;
    const text = substitute(String(config.state_template ?? "{auto}"), vars) || fallback;

    return { idle, prompt, tool, task, details, text };
}

function fingerprint(entry) {
    return [entry.session_id, entry.started_at, entry.state, entry.text, entry.details, entry.prompt, entry.task].join("\u0000");
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
        writeTextIfChanged(configPath, CONFIG_TEMPLATE);
    }

    try {
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.appendFileSync(
            path.join(runtimeDir, "hook-trace.log"),
            `${new Date().toTimeString().slice(0, 8)} ${event} ${payload.tool_name || ""} sid=${payload.session_id}\n`,
        );
    } catch { /* tracing is best-effort */ }

    const state = readJson(path.join(runtimeDir, "state.json")) ?? {};
    const activity = buildPresence(event, payload, config, state);
    if (!activity) return;

    const sessionId = String(payload.session_id || state.session_id || "");
    const now = Date.now() / 1000;
    const startedAt =
        event === "SessionStart" || !sessionId || sessionId !== String(state.session_id || "")
            ? Math.floor(now)
            : Math.floor(Number(state.started_at) || now);

    const newState = {
        version: STATE_VERSION,
        session_id: sessionId,
        started_at: startedAt,
        state: activity.idle ? "idle" : "working",
        text: activity.text,
        details: activity.details,
        prompt: activity.prompt,
        tool: activity.tool,
        task: activity.task,
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
