#!/usr/bin/env node
/**
 * Discord Rich Presence daemon for the zcode-discord-rpc plugin.
 *
 * Polls <runtime_dir>/state.json (written by hooks/rpc-hook.mjs) and keeps a
 * long-lived connection to Discord's local IPC socket so the presence does
 * not disappear when short-lived hook processes exit.
 *
 * Discord IPC protocol (all desktop platforms):
 * unix socket `discord-ipc-<n>` on Linux/macOS, named pipe
 * `\\.\pipe\discord-ipc-<n>` on Windows. Frames are: 4-byte little-endian
 * opcode, 4-byte little-endian payload length, JSON payload.
 * Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const PLUGIN_NAME = "zcode-discord-rpc";
// Public "ZCode" Discord application used as the zero-setup default, so a
// fresh install works without creating an own application. Users can point
// config.client_id at their own application for custom branding.
const BUILT_IN_CLIENT_ID = "1543388667379449978";
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

const POLL_INTERVAL = 1000;
const RECONNECT_BACKOFF = 3000;
const HANDSHAKE_FAIL_BACKOFF = 60000;
const MIN_SEND_INTERVAL = 2000;
const KEEPALIVE_EVERY = 25000;
const KEEPALIVE_DEAD_AFTER = 45000;
const DETAILS_LIMIT = 128;
const STATE_LIMIT = 128;

const log = (msg) => {
    // synchronous write: process.exit() must never swallow log lines
    try { fs.writeSync(1, `[${PLUGIN_NAME}] ${new Date().toTimeString().slice(0, 8)} ${msg}\n`); } catch { /* ignore */ }
};

function defaultRuntimeDir() {
    if (process.platform === "win32") {
        const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(root, PLUGIN_NAME);
    }
    const root = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    return path.join(root, PLUGIN_NAME);
}

function defaultConfigDir() {
    if (process.platform === "win32") {
        const root = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
        return path.join(root, PLUGIN_NAME);
    }
    const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(root, PLUGIN_NAME);
}

function readJson(filePath) {
    try {
        // full-line "//" comments are allowed in config files
        const cleaned = fs
            .readFileSync(filePath, "utf8")
            .split("\n")
            .filter((line) => !/^\s*\/\//.test(line))
            .join("\n");
        const data = JSON.parse(cleaned);
        return data && typeof data === "object" ? data : null;
    } catch {
        return null;
    }
}

function socketCandidates() {
    if (process.platform === "win32") {
        return Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
    }
    const dirs = [
        process.env.XDG_RUNTIME_DIR,
        `/run/user/${process.getuid()}`,
        process.env.TMPDIR || "/tmp",
        "/tmp",
    ];
    const seen = new Set();
    const paths = [];
    for (const base of dirs) {
        if (!base || seen.has(base)) continue;
        seen.add(base);
        for (let i = 0; i < 10; i++) paths.push(path.join(base, `discord-ipc-${i}`));
    }
    return paths;
}

class HandshakeRejected extends Error {}

class DiscordIPC {
    constructor() {
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.closed = true;
        this.lastPing = 0;
        this.lastAlive = Date.now();
        this.lastErrorMessage = null;
        this._handshakeWaiter = null;
    }

    connect(clientId) {
        return new Promise((resolve, reject) => {
            const candidates = socketCandidates();
            const attempt = (index, errors) => {
                if (index >= candidates.length) {
                    reject(new ConnectionError(`no Discord IPC socket reachable: ${errors.slice(0, 3).join("; ") || "none found"}`));
                    return;
                }
                this._connectOne(candidates[index], clientId).then(
                    () => resolve(),
                    (exc) => {
                        if (exc instanceof HandshakeRejected) {
                            reject(exc);
                            return;
                        }
                        errors.push(`${candidates[index]}: ${exc.message}`);
                        attempt(index + 1, errors);
                    },
                );
            };
            attempt(0, []);
        });
    }

    _connectOne(sockPath, clientId) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const sock = net.connect({ path: sockPath });
            this.socket = sock;
            const isCurrent = () => this.socket === sock;
            const fail = (exc) => {
                if (settled) return;
                settled = true;
                try { sock.destroy(); } catch { /* ignore */ }
                if (isCurrent()) this.socket = null;
                reject(exc);
            };
            // persistent handler: network errors are expected at any phase;
            // late errors from stale attempts must not touch shared state
            sock.on("error", (exc) => {
                if (!isCurrent()) {
                    try { sock.destroy(); } catch { /* ignore */ }
                    return;
                }
                this.closed = true;
                fail(exc);
            });
            sock.setTimeout(2000, () => fail(new Error("connect timeout")));
            sock.once("connect", () => {
                if (!isCurrent()) {
                    try { sock.destroy(); } catch { /* ignore */ }
                    return;
                }
                sock.setTimeout(0);
                sock.on("data", (chunk) => this._onData(chunk));
                sock.once("close", () => {
                    if (isCurrent()) this.closed = true;
                });
                this.closed = false; // open for the handshake frames
                this._sendFrame(OP.HANDSHAKE, { v: 1, client_id: String(clientId) });
                const timer = setTimeout(() => fail(new Error("handshake timeout")), 5000);
                this._handshakeWaiter = (frame) => {
                    clearTimeout(timer);
                    this._handshakeWaiter = null;
                    if (frame.opcode === OP.FRAME && (!frame.obj || frame.obj.evt == null || frame.obj.evt === "READY")) {
                        this.closed = false;
                        this.lastAlive = Date.now();
                        this.lastErrorMessage = null;
                        settled = true;
                        resolve();
                    } else {
                        fail(new HandshakeRejected(JSON.stringify(frame.obj)?.slice(0, 120) || "unexpected reply"));
                    }
                };
            });
        });
    }

    _onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 8) {
            const opcode = this.buffer.readUInt32LE(0);
            const length = this.buffer.readUInt32LE(4);
            if (this.buffer.length < 8 + length) break;
            const body = this.buffer.subarray(8, 8 + length);
            this.buffer = this.buffer.subarray(8 + length);
            let obj = null;
            try {
                obj = length > 0 ? JSON.parse(body.toString("utf8")) : null;
            } catch { /* ignore malformed payloads */ }

            if (this._handshakeWaiter) {
                this._handshakeWaiter({ opcode, obj });
                continue;
            }
            this.lastAlive = Date.now();
            if (opcode === OP.PING) {
                this._sendFrame(OP.PONG, obj ?? {});
            } else if (opcode === OP.CLOSE) {
                this.closed = true;
                this.socket?.destroy();
            } else if (opcode === OP.FRAME && obj?.evt === "ERROR") {
                const message = String(obj.data?.message || JSON.stringify(obj));
                if (message !== this.lastErrorMessage) {
                    this.lastErrorMessage = message;
                    log(`Discord RPC error: ${message}`);
                }
            }
        }
    }

    _sendFrame(opcode, payload) {
        if (!this.socket || this.closed || this.socket.destroyed) {
            throw new ConnectionError("not connected");
        }
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        const header = Buffer.alloc(8);
        header.writeUInt32LE(opcode, 0);
        header.writeUInt32LE(body.length, 4);
        this.socket.write(Buffer.concat([header, body]));
    }

    sendActivity(activity) {
        const args = { pid: process.pid };
        if (activity) args.activity = activity;
        this._sendFrame(OP.FRAME, { cmd: "SET_ACTIVITY", args, nonce: randomNonce() });
    }

    ping() {
        this._sendFrame(OP.PING, { v: 1 });
        this.lastPing = Date.now();
    }

    close() {
        try { this.socket?.destroy(); } catch { /* ignore */ }
        this.socket = null;
        this.closed = true;
        this.buffer = Buffer.alloc(0);
        this._handshakeWaiter = null;
    }
}

class ConnectionError extends Error {}

function randomNonce() {
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function otherDaemonAlive(pidFile) {
    let pid = NaN;
    try {
        pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
        return false;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (exc) {
        return exc.code === "EPERM";
    }
}

function buildActivity(state, config) {
    const activity = {
        details: String(state.details || "ZCode").slice(0, DETAILS_LIMIT),
        state: String(state.text || "").slice(0, STATE_LIMIT),
        timestamps: { start: Math.floor(Number(state.started_at) || Date.now() / 1000) },
        instance: false,
    };
    const assets = {};
    const largeKey = String(config.large_image_key || "").trim();
    if (largeKey && largeKey.toLowerCase() !== "none") {
        assets.large_image = largeKey;
        assets.large_text = String(config.large_image_text || "ZCode").slice(0, DETAILS_LIMIT);
    }
    const smallKey = String(config.small_image_key || "").trim();
    if (smallKey && smallKey.toLowerCase() !== "none") {
        assets.small_image = smallKey;
        assets.small_text = String(config.small_image_text || "").slice(0, DETAILS_LIMIT);
    }
    if (Object.keys(assets).length > 0) activity.assets = assets;
    return activity;
}

function fingerprintOf(state) {
    return [state.session_id, state.started_at, state.state, state.text, state.details].join("\u0000");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    // a background daemon must survive any unexpected network hiccup
    process.on("uncaughtException", (exc) => {
        log(`uncaught exception (daemon continues): ${exc?.message || exc}`);
        try { ipc?.close(); } catch { /* ignore */ }
        ipc = null;
        activeClientId = null;
        lastFingerprint = null;
    });
    process.on("unhandledRejection", (exc) => {
        log(`unhandled rejection (daemon continues): ${exc?.message || exc}`);
    });

    const runtimeDir = path.resolve(process.argv[2] || defaultRuntimeDir());
    const configDir = (process.env.ZCODE_DISCORD_RPC_DIR || "").trim() ? runtimeDir : defaultConfigDir();
    fs.mkdirSync(runtimeDir, { recursive: true });
    const pidFile = path.join(runtimeDir, "daemon.pid");
    if (otherDaemonAlive(pidFile)) return;
    try {
        // exclusive create: lose cleanly if a parallel hook spawned first
        fs.writeFileSync(pidFile, String(process.pid), { flag: "wx" });
    } catch {
        // the winner may not have flushed its pid yet — give it a moment
        await sleep(100);
        if (otherDaemonAlive(pidFile)) return;
        fs.writeFileSync(pidFile, String(process.pid));
    }

    let running = true;
    const stop = () => { running = false; };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    const configPath = path.join(configDir, "config.json");
    const statePath = path.join(runtimeDir, "state.json");

    let ipc = null;
    let activeClientId = null;
    let lastFingerprint = null;
    let lastSend = 0;
    let handshakeFailedAt = 0;
    let lastEventTs = 0;
    let lastConnectError = null;

    log(`daemon started (pid ${process.pid}, runtime ${runtimeDir})`);
    try {
        while (running) {
            const config = readJson(configPath) ?? {};
            const state = readJson(statePath);
            const now = Date.now();

            const eventTs = Number(state?.ts) || 0;
            if (eventTs) lastEventTs = Math.max(lastEventTs, eventTs * 1000);
            const idleMinutes = Number(config.idle_timeout_min) || 60;
            if (lastEventTs && now - lastEventTs > idleMinutes * 60000) {
                log(`idle for ${idleMinutes.toFixed(0)} min, clearing presence and exiting`);
                if (ipc && !ipc.closed) {
                    try { ipc.sendActivity(null); } catch { /* best effort */ }
                }
                break;
            }

            const clientId = String(config.client_id || "").trim() || BUILT_IN_CLIENT_ID;

            if (ipc && !ipc.closed && activeClientId !== clientId) {
                log(`client_id changed (${JSON.stringify(activeClientId)} -> ${JSON.stringify(clientId)}), reconnecting`);
                ipc.close();
                ipc = null;
                activeClientId = null;
                lastFingerprint = null;
                await sleep(POLL_INTERVAL);
                continue;
            }

            let fingerprint = null;
            let activity = null;
            if (state?.version) {
                fingerprint = fingerprintOf(state);
                activity = buildActivity(state, config);
            }

            if (!ipc || ipc.closed) {
                if (now - handshakeFailedAt < HANDSHAKE_FAIL_BACKOFF) {
                    await sleep(POLL_INTERVAL);
                    continue;
                }
                try {
                    ipc = new DiscordIPC();
                    await ipc.connect(clientId);
                    activeClientId = clientId;
                    lastFingerprint = null;
                    log(`connected to Discord (client_id=${clientId})`);
                } catch (exc) {
                    ipc = null;
                    if (exc instanceof HandshakeRejected) {
                        log(`handshake rejected, check client_id (${exc.message}); retrying in ${HANDSHAKE_FAIL_BACKOFF / 1000}s`);
                        handshakeFailedAt = Date.now();
                    } else {
                        if (exc.message !== lastConnectError) {
                            lastConnectError = exc.message;
                            log(`connect failed: ${exc.message}`);
                        }
                        await sleep(RECONNECT_BACKOFF);
                    }
                    continue;
                }
            }

            const alive = () => {
                if (ipc.closed) throw new ConnectionError("connection closed");
                if (Date.now() - ipc.lastAlive > KEEPALIVE_DEAD_AFTER) {
                    throw new ConnectionError("keepalive timeout");
                }
            };

            try {
                if (fingerprint !== null && fingerprint !== lastFingerprint && Date.now() - lastSend >= MIN_SEND_INTERVAL) {
                    ipc.sendActivity(activity);
                    lastFingerprint = fingerprint;
                    lastSend = Date.now();
                }
                if (Date.now() - ipc.lastPing > KEEPALIVE_EVERY) ipc.ping();
                alive();
            } catch (exc) {
                log(`connection lost (${exc.message}); will reconnect`);
                try { ipc?.close(); } catch { /* ignore */ }
                ipc = null;
                activeClientId = null;
                await sleep(RECONNECT_BACKOFF);
                continue;
            }

            await sleep(POLL_INTERVAL);
        }
    } finally {
        if (ipc && !ipc.closed) {
            try { ipc.sendActivity(null); } catch { /* best effort */ }
            ipc.close();
        }
        try {
            if (fs.readFileSync(pidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidFile);
        } catch { /* already gone */ }
        log("daemon stopped");
    }
    return 0;
}

main().then(
    (code) => process.exit(code ?? 0),
    (exc) => {
        console.error(`[${PLUGIN_NAME}] fatal: ${exc?.stack || exc}`);
        process.exit(1);
    },
);
