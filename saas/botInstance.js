/**
 * KING RED AI SaaS
 * One WhatsApp connection per SaaS user.
 * CommonJS edition.
 */

const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;

const {
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
} = baileys;

const NodeCache = require("node-cache");
const P = require("pino");

const { handleMessages } = require("../lib/commandHandler");
const {
    handleAutomation,
    handleMessageDelete
} = require("../lib/automation");

const botContext = require("../lib/botContext");
const { createUserStore } = require("../redtech/jsonStore");
const SettingsManager = require("./settingsManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class BotInstance {
    constructor(userId, options = {}) {
        if (!userId) {
            throw new Error("A user ID is required.");
        }

        this.userId = String(userId);
        this.sessionDir = path.join(
            __dirname,
            "../sessions",
            this.userId
        );

        this.store = createUserStore(this.userId);
        this.settingsManager = new SettingsManager(this.store);

        // Connection state.
        this.sock = null;
        this.latestQr = null;
        this.myJid = null;
        this.botStartTime = null;
        this.status = "offline";
        this.isReconnecting = false;
        this.stopped = false;
        this.consecutiveFailures = 0;

        // Timers.
        this.reconnectTimer = null;
        this.pairingTimer = null;
        this.alwaysOnlineInterval = null;
        this.healthCheckInterval = null;

        // Pairing state.
        this.pairingCodeResolve = null;
        this.pairingCodeReject = null;
        this.pairingRestartInProgress = false;
        this.pairingCodeRequested = false;
        this.pendingPairingNumber = null;

        // Session state.
        this.sessionId = options.sessionId || null;
        this.sessionIdInvalid = false;
        this.sessionInvalidated = false;
        this.hasWipedSessionOnStartup = false;
        this.restoredFromDatabase = false;

        // Optional channel metadata.
        this.newsletterJid = "120363428521307680@newsletter";
        this.newsletterName = "KING RED AI Updates";
        this.newsletterInviteLink = "";
    }

    _runInContext(fn) {
        return botContext.run({
            store: this.store,
            settingsCache: this.settingsManager.get(),
            settingsManager: this.settingsManager,
            myJid: this.myJid
        }, fn);
    }

    async start() {
        if (this.isReconnecting || this.status === "online") {
            return this;
        }

        this.stopped = false;
        this.sessionInvalidated = false;

        fs.mkdirSync(this.sessionDir, { recursive: true });

        await this.settingsManager.load();
        await this._connectionLogic();

        return this;
    }

    stop() {
        this.stopped = true;
        this.status = "offline";
        this.latestQr = null;
        this.myJid = null;
        this.pairingRestartInProgress = false;

        this._clearTimers();
        this._rejectPendingPairing(
            new Error("Bot connection was stopped.")
        );

        const socket = this.sock;
        this.sock = null;

        if (socket) {
            try {
                socket.end(new Error("KING RED AI stopped"));
            } catch (_) {}
        }
    }

    _rejectPendingPairing(error) {
        if (this.pairingCodeReject) {
            this.pairingCodeReject(error);
        }

        this.pairingCodeResolve = null;
        this.pairingCodeReject = null;
    }

    triggerPairingRestart(phone) {
        const number = String(phone || "").replace(/\D/g, "");

        if (!/^\d{7,15}$/.test(number)) {
            return Promise.reject(
                new Error("Enter a valid international phone number.")
            );
        }

        if (this.stopped) {
            this.stopped = false;
        }

        this._rejectPendingPairing(
            new Error("Pairing request replaced.")
        );

        this._clearTimers();
        this.pendingPairingNumber = number;
        this.pairingCodeRequested = false;
        this.sessionId = null;
        this.sessionIdInvalid = false;
        this.sessionInvalidated = false;
        this.pairingRestartInProgress = true;

        this.wipeSession();

        const oldSocket = this.sock;
        this.sock = null;

        if (oldSocket) {
            try {
                oldSocket.end(new Error("Restarting pairing"));
            } catch (_) {}
        }

        const promise = new Promise((resolve, reject) => {
            this.pairingCodeResolve = resolve;
            this.pairingCodeReject = reject;

            this.pairingTimer = setTimeout(() => {
                if (this.pairingCodeReject === reject) {
                    this.pairingCodeResolve = null;
                    this.pairingCodeReject = null;
                    this.pendingPairingNumber = null;
                    this.pairingRestartInProgress = false;

                    reject(
                        new Error("Timed out waiting for a pairing code.")
                    );
                }
            }, 60000);
        });

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            this._connectionLogic().catch(error => {
                this.isReconnecting = false;
                this.status = "offline";
                this._rejectPendingPairing(error);
                console.error(
                    `[${this.userId}] Pairing startup failed:`,
                    error.message
                );
            });
        }, 500);

        return promise;
    }

    wipeSession() {
        try {
            fs.mkdirSync(this.sessionDir, { recursive: true });

            for (const file of fs.readdirSync(this.sessionDir)) {
                const fullPath = path.join(this.sessionDir, file);

                try {
                    const stat = fs.lstatSync(fullPath);

                    if (stat.isFile() || stat.isSymbolicLink()) {
                        fs.unlinkSync(fullPath);
                    } else if (stat.isDirectory()) {
                        fs.rmSync(fullPath, {
                            recursive: true,
                            force: true
                        });
                    }
                } catch (_) {}
            }
        } catch (error) {
            console.error(
                `[${this.userId}] Session cleanup failed:`,
                error.message
            );
        }
    }

    getSessionId() {
        const credsPath = path.join(this.sessionDir, "creds.json");

        if (!fs.existsSync(credsPath)) return null;

        try {
            const data = fs.readFileSync(credsPath, "utf8");

            if (data.length < 10) return null;

            return "KINGRED~" + Buffer.from(data).toString("base64");
        } catch (_) {
            return null;
        }
    }

    restoreSessionId(sessionId) {
        const raw = String(sessionId || "").trim();

        if (!raw) {
            throw new Error("Session ID is empty.");
        }

        const encoded = raw.includes("~")
            ? raw.slice(raw.indexOf("~") + 1)
            : raw;

        let decoded = Buffer.from(encoded, "base64");

        const decompress = buffer => {
            for (const method of [
                zlib.gunzipSync,
                zlib.inflateSync,
                zlib.inflateRawSync
            ]) {
                try {
                    return method(buffer).toString("utf8");
                } catch (_) {}
            }

            return buffer.toString("utf8");
        };

        let text = decompress(decoded);

        // Support session IDs containing a second base64 layer.
        if (!text.trim().startsWith("{")) {
            const trimmed = text.trim();

            if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
                try {
                    decoded = Buffer.from(trimmed, "base64");
                    text = decompress(decoded);
                } catch (_) {}
            }
        }

        let parsed;

        try {
            parsed = JSON.parse(text);
        } catch (_) {
            const start = text.indexOf("{");
            const end = text.lastIndexOf("}");

            if (start < 0 || end <= start) {
                throw new Error("Session ID does not contain valid JSON.");
            }

            parsed = JSON.parse(text.slice(start, end + 1));
        }

        const creds = parsed.creds || parsed;

        if (!creds || !creds.noiseKey) {
            throw new Error("Session ID does not contain WhatsApp credentials.");
        }

        creds.registered = true;

        fs.mkdirSync(this.sessionDir, { recursive: true });

        fs.writeFileSync(
            path.join(this.sessionDir, "creds.json"),
            JSON.stringify(creds, null, 2),
            { mode: 0o600 }
        );
    }

    waitForSessionState(timeoutMs = 15000) {
        if (this.status === "online") {
            return Promise.resolve("online");
        }

        if (this.sessionInvalidated) {
            return Promise.resolve("invalid");
        }

        return new Promise(resolve => {
            const started = Date.now();

            const check = () => {
                if (this.status === "online") {
                    return resolve("online");
                }

                if (this.sessionInvalidated) {
                    return resolve("invalid");
                }

                if (Date.now() - started >= timeoutMs) {
                    return resolve("timeout");
                }

                setTimeout(check, 250);
            };

            check();
        });
    }

    async _getAuthState() {
        try {
            const db = require("../redtech/db");

            if (
                typeof db.initDb === "function" &&
                typeof db.isOnline === "function"
            ) {
                await db.initDb();

                if (db.isOnline()) {
                    const dbAuth = require("../redtech/dbAuth");

                    if (
                        typeof dbAuth.useDatabaseAuthState === "function"
                    ) {
                        const auth = await dbAuth.useDatabaseAuthState(
                            `saas_${this.userId}`
                        );

                        if (auth && auth.state && auth.saveCreds) {
                            this.restoredFromDatabase =
                                !!auth.state.creds.registered;

                            return auth;
                        }
                    }
                }
            }
        } catch (error) {
            console.error(
                `[${this.userId}] Database auth unavailable; using local session:`,
                error.message
            );
        }

        this.restoredFromDatabase = false;

        return useMultiFileAuthState(this.sessionDir);
    }

    async _connectionLogic() {
        if (this.stopped || this.isReconnecting) return;

        this.isReconnecting = true;
        this.status = "connecting";

        let socket = null;

        try {
            fs.mkdirSync(this.sessionDir, { recursive: true });

            // Restore an explicitly supplied session ID if no local
            // credentials are available.
            if (this.sessionId && !this.sessionIdInvalid) {
                const credsPath = path.join(
                    this.sessionDir,
                    "creds.json"
                );

                const hasCredentials =
                    fs.existsSync(credsPath) &&
                    fs.statSync(credsPath).size > 10;

                if (!hasCredentials) {
                    try {
                        this.restoreSessionId(this.sessionId);
                    } catch (error) {
                        console.error(
                            `[${this.userId}] Session restoration failed:`,
                            error.message
                        );
                    }
                }
            }

            let auth = await this._getAuthState();

            if (this.stopped) {
                this.isReconnecting = false;
                return;
            }

            let { state, saveCreds } = auth;

            // Remove stale local files for a fresh login.
            if (
                !this.hasWipedSessionOnStartup &&
                !state.creds.registered &&
                !this.sessionId &&
                !this.restoredFromDatabase
            ) {
                this.hasWipedSessionOnStartup = true;

                this.wipeSession();

                auth = await useMultiFileAuthState(this.sessionDir);
                state = auth.state;
                saveCreds = auth.saveCreds;
            }

            const pairingMode =
                !!this.pendingPairingNumber &&
                !state.creds.registered;

            const logger = P({ level: "silent" });
            const retryCache = new NodeCache();

            let version;

            try {
                const latest = await fetchLatestBaileysVersion();
                version = latest.version;
            } catch (_) {
                version = undefined;
            }

            if (this.stopped) {
                this.isReconnecting = false;
                return;
            }

            socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
                },
                logger,
                ...(version ? { version } : {}),
                browser: Browsers.ubuntu("Chrome"),
                markOnlineOnConnect: true,
                msgRetryCounterCache: retryCache,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,

                getMessage: async key => {
                    try {
                        const model = require("../redtech/messageModel");

                        if (typeof model.getMessage === "function") {
                            const message = await model.getMessage(key.id);
                            return message?.content;
                        }

                        if (typeof model.get === "function") {
                            const message = await model.get(key.id);
                            return message?.content;
                        }
                    } catch (_) {}

                    return undefined;
                }
            });

            this.sock = socket;
            socket.newsletterJid = this.newsletterJid;
            socket.newsletterName = this.newsletterName;

            socket.ev.on("creds.update", async (...args) => {
                try {
                    await saveCreds(...args);
                } catch (error) {
                    console.error(
                        `[${this.userId}] Saving credentials failed:`,
                        error.message
                    );
                }
            });

            socket.ev.on("connection.update", async update => {
                if (this.sock !== socket || this.stopped) return;

                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.latestQr = qr;
                }

                // Request a phone pairing code once the socket has
                // initialized and the account is not already registered.
                if (
                    pairingMode &&
                    this.pendingPairingNumber &&
                    !this.pairingCodeRequested &&
                    (connection === "connecting" || !!qr)
                ) {
                    this.pairingCodeRequested = true;

                    try {
                        await sleep(1200);

                        if (
                            this.sock !== socket ||
                            this.stopped ||
                            !this.pendingPairingNumber
                        ) {
                            return;
                        }

                        const number = this.pendingPairingNumber;

                        const code = await socket.requestPairingCode(number);

                        if (this.pairingCodeResolve) {
                            this.pairingCodeResolve(code);
                            this.pairingCodeResolve = null;
                            this.pairingCodeReject = null;

                            if (this.pairingTimer) {
                                clearTimeout(this.pairingTimer);
                                this.pairingTimer = null;
                            }
                        }

                        this.pendingPairingNumber = null;
                    } catch (error) {
                        this.pairingCodeRequested = false;

                        this._rejectPendingPairing(
                            new Error(
                                `Pairing code request failed: ${error.message}`
                            )
                        );

                        console.error(
                            `[${this.userId}] Pairing code request failed:`,
                            error.message
                        );
                    }
                }

                if (connection === "connecting") {
                    this.status = "connecting";
                }

                if (connection === "open") {
                    this.status = "online";
                    this.isReconnecting = false;
                    this.consecutiveFailures = 0;
                    this.latestQr = null;
                    this.myJid = socket.user?.id || null;
                    this.botStartTime = Date.now();
                    this.sessionId = null;
                    this.sessionInvalidated = false;
                    this.pairingRestartInProgress = false;

                    console.log(
                        `[${this.userId}] KING RED AI connected: ${this.myJid || "WhatsApp"}`
                    );

                    this._startTimers();
                    return;
                }

                if (connection === "close") {
                    if (this.sock !== socket) return;

                    this.sock = null;
                    this.myJid = null;
                    this.latestQr = null;
                    this._clearRuntimeTimers();

                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    const loggedOut =
                        statusCode === DisconnectReason.loggedOut;

                    if (loggedOut) {
                        this.status = "offline";
                        this.sessionInvalidated = true;
                        this.sessionIdInvalid = true;

                        this._rejectPendingPairing(
                            new Error(
                                "WhatsApp logged out. Request a new pairing code."
                            )
                        );

                        console.error(
                            `[${this.userId}] WhatsApp session logged out.`
                        );

                        return;
                    }

                    if (this.stopped) {
                        this.status = "offline";
                        return;
                    }

                    this.status = "reconnecting";
         
