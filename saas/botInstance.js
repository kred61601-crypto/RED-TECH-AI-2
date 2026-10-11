/**
 * botInstance — one WhatsApp connection per SaaS user.
 *
 * Keeps connection state scoped to each SaaS user.
 * Message processing runs inside AsyncLocalStorage.run().
 */

const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const {
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const makeWASocket = require("@whiskeysockets/baileys").default;
const QRCode = require("qrcode");
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
const { version: botVersion } = require("../config");

class BotInstance {
    constructor(userId, options = {}) {
        this.userId = userId;
        this.sessionDir = path.join(__dirname, `../sessions/${userId}`);
        this.store = createUserStore(userId);
        this.settingsManager = new SettingsManager(this.store);

        // Runtime state
        this.sock = null;
        this.latestQr = null;
        this.myJid = null;
        this.botStartTime = null;
        this.status = "offline";
        this.isReconnecting = false;
        this.stopped = false;
        this.consecutiveFailures = 0;
        this.hasWipedSessionOnStartup = false;

        // Timers
        this.alwaysOnlineInterval = null;
        this.healthCheckInterval = null;

        // Pairing
        this.pairingCodeResolve = null;
        this.pairingCodeReject = null;
        this.pairingRestartInProgress = false;
        this.pairingCodeRequested = false;
        this.pendingPairingNumber = null;
        this.sessionIdFailed = false;
        this.sessionIdInvalid = false;
        this.sessionInvalidated = false;
        this.restoredFromDatabase = false;

        // WhatsApp channel
        this.newsletterJid = "120363428521307680@newsletter";
        this.newsletterName = "Redtech Ai Updates";
        this.newsletterInviteLink =
            "https://whatsapp.com/channel/0029Vb9AwScF6sn47ClubG1Z";

        // User's WhatsApp number for pairing
        this.sessionId = options.sessionId || null;
    }

    // ── Context runner ──────────────────────────────────────────────

    _runInContext(fn) {
        const ctx = {
            store: this.store,
            settingsCache: this.settingsManager.get(),
            settingsManager: this.settingsManager,
            myJid: this.myJid,
        };

        return botContext.run(ctx, fn);
    }

    // ── Start ───────────────────────────────────────────────────────

    async start() {
        this.stopped = false;
        this.sessionInvalidated = false;

        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        await this.settingsManager.load();
        await this._connectionLogic();
    }

    // ── Stop ────────────────────────────────────────────────────────

    stop() {
        this.stopped = true;
        this._clearTimers();

        if (this.sock) {
            try {
                this.sock.end(new Error("BotInstance stopped"));
            } catch (_) {}

            this.sock = null;
        }

        this.status = "offline";
        this.latestQr = null;
        this.myJid = null;
    }

    // ── Pairing trigger ─────────────────────────────────────────────

    triggerPairingRestart(phone) {
        return new Promise((resolve, reject) => {
            this.pairingCodeResolve = resolve;
            this.pairingCodeReject = reject;

            const timer = setTimeout(() => {
                if (this.pairingCodeResolve === resolve) {
                    this.pairingCodeResolve = null;
                    this.pairingCodeReject = null;

                    reject(
                        new Error(
                            "Timed out waiting for pairing code (25s)."
                        )
                    );
                }
            }, 25000);

            if (timer.unref) timer.unref();

            this.pendingPairingNumber = phone;
            this.pairingCodeRequested = false;
            this.sessionId = null;
            this.sessionIdFailed = false;

            // Wipe stale session
            try {
                if (fs.existsSync(this.sessionDir)) {
                    fs.readdirSync(this.sessionDir).forEach(f => {
                        try {
                            fs.unlinkSync(
                                path.join(this.sessionDir, f)
                            );
                        } catch (_) {}
                    });
                }
            } catch (_) {}

            this.pairingRestartInProgress = true;

            if (this.sock) {
                const oldSock = this.sock;

                try {
                    oldSock.end(new Error("Pairing restart"));
                } catch (_) {}

                this.sock = null;
            }

            // Restart even if the previous socket already closed.
            setTimeout(() => {
                if (
                    this.pairingRestartInProgress &&
                    !this.isReconnecting &&
                    !this.stopped
                ) {
                    this._connectionLogic();
                }
            }, 150);
        });
    }

    // ── Session management ──────────────────────────────────────────

    wipeSession() {
        try {
            if (fs.existsSync(this.sessionDir)) {
                fs.readdirSync(this.sessionDir).forEach(f => {
                    try {
                        fs.unlinkSync(
                            path.join(this.sessionDir, f)
                        );
                    } catch (_) {}
                });
            }
        } catch (e) {
            console.error(
                `[${this.userId}] wipeSession error:`,
                e.message
            );
        }
    }

    getSessionId() {
        const credsPath = path.join(
            this.sessionDir,
            "creds.json"
        );

        if (
            !fs.existsSync(credsPath) ||
            fs.statSync(credsPath).size < 10
        ) {
            return null;
        }

        const creds = fs.readFileSync(credsPath, "utf-8");

        return "REDTECH~" +
            Buffer.from(creds).toString("base64");
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

                if (
                    this.sessionInvalidated ||
                    Date.now() - started >= timeoutMs
                ) {
                    return resolve(
                        this.sessionInvalidated
                            ? "invalid"
                            : "timeout"
                    );
                }

                setTimeout(check, 250);
            };

            check();
        });
    }

    restoreSessionId(sessionId) {
        const rawId = sessionId.trim();

        // Accept either the REDTECH~ or legacy prefix.
        const encoded = rawId.includes("~")
            ? rawId.split("~")[1]
            : rawId;

        const buffer = Buffer.from(encoded, "base64");

        const decodeBuffer = (buf) => {
            try {
                return zlib.gunzipSync(buf).toString("utf-8");
            } catch (_) {
                try {
                    return zlib.inflateSync(buf).toString("utf-8");
                } catch (_) {
                    return buf.toString("utf-8");
                }
            }
        };

        let credsJson = decodeBuffer(buffer);

        if (
            !credsJson.includes("{") &&
            /^[a-zA-Z0-9+/=]+$/.test(credsJson.trim())
        ) {
            credsJson = decodeBuffer(
                Buffer.from(credsJson.trim(), "base64")
            );
        }

        let finalJson = null;

        for (let i = 0; i < credsJson.length; i++) {
            if (credsJson[i] === "{") {
                try {
                    const candidate = credsJson.substring(
                        i,
                        credsJson.lastIndexOf("}") + 1
                    );

                    if (
                        candidate.includes("noiseKey") ||
                        candidate.includes("creds")
                    ) {
                        JSON.parse(candidate);
                        finalJson = candidate;
                        break;
                    }
                } catch (_) {}
            }
        }

        if (!finalJson) {
            throw new Error(
                "Could not find valid credentials in that Session ID."
            );
        }

        const parsed = JSON.parse(finalJson);
        const creds = parsed.creds ||
            (parsed.noiseKey ? parsed : null);

        if (!creds) {
            throw new Error(
                "No credentials found inside Session ID."
            );
        }

        creds.registered = true;

        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, {
                recursive: true
            });
        }

        fs.writeFileSync(
            path.join(this.sessionDir, "creds.json"),
            JSON.stringify(creds)
        );
    }

    // ── Core connection logic ───────────────────────────────────────

    async _connectionLogic() {
        if (this.stopped) return;
        if (this.isReconnecting) return;

        this.isReconnecting = true;
        this.status = "connecting";

        // Restore SESSION_ID when necessary.
        if (this.sessionId && !this.sessionIdInvalid) {
            const credsPath = path.join(
                this.sessionDir,
                "creds.json"
            );

            const sessionExists =
                fs.existsSync(credsPath) &&
                fs.statSync(credsPath).size > 10;

            if (!sessionExists) {
                console.log(
                    `[${this.userId}] Restoring session from SESSION_ID...`
                );

                try {
                    this.restoreSessionId(this.sessionId);

                    console.log(
                        `[${this.userId}] Session restored.`
                    );
                } catch (e) {
                    console.error(
                        `[${this.userId}] Session restore failed:`,
                        e.message
                    );
                }
            }
        }

        // Use MongoDB authentication where available.
        let authState;
        let usingDatabaseAuth = false;

        try {
            const { initDb, isOnline } =
                require("../redtech/db");

            await initDb();

            if (isOnline()) {
                const { useDatabaseAuthState } =
                    require("../redtech/dbAuth");

                authState = await useDatabaseAuthState(
                    `saas_${this.userId}`
                );

                usingDatabaseAuth = true;

                console.log(
                    `[${this.userId}] Using MongoDB auth state.`
                );
            }
        } catch (error) {
            console.error(
                `[${this.userId}] MongoDB auth state unavailable:`,
                error.message
            );
        }

        // Do not start another socket after stop().
        if (this.stopped) {
            this.isReconnecting = false;
            return;
        }

        if (!authState) {
            authState = await useMultiFileAuthState(
                this.sessionDir
            );
        }

        let { state, saveCreds } = authState;

        this.restoredFromDatabase =
            usingDatabaseAuth && !!state.creds.registered;

        // Fresh login cleanup.
        if (
            !this.hasWipedSessionOnStartup &&
            !state.creds.registered &&
            !this.sessionId
        ) {
            this.hasWipedSessionOnStartup = true;

            try {
                if (fs.existsSync(this.sessionDir)) {
                    fs.readdirSync(this.sessionDir).forEach(file => {
                        try {
                            fs.unlinkSync(
                                path.join(this.sessionDir, file)
                            );
                        } catch (_) {}
                    });
                }

                const freshState =
                    await useMultiFileAuthState(this.sessionDir);

                state = freshState.state;
                saveCreds = freshState.saveCreds;
            } catch (e) {
                console.error(
                    `[${this.userId}] Failed to clean session folder:`,
                    e.message
                );
            }
        }

        const usePairingCode =
            !!this.pendingPairingNumber &&
            !state.creds.registered;

        const msgRetryCounterCache = new NodeCache();
        const logger = P({ level: "silent" });

        let version = [2, 3000, 1017531287];

        try {
            const { version: latestVer } =
                await fetchLatestBaileysVersion();

            version = latestVer;
        } catch (_) {}

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                ),
            },
            logger,
            version,
            markOnline: true,
            browser: Browsers.ubuntu("Chrome"),
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            linkPreviewHighQuality: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,

            getMessage: async (key) => {
                try {
                    const { getMessage: getMsg } =
                        require("../redtech/messageModel");

                    const msg = await getMsg(key.id);

                    return msg ? msg.content : undefined;
                } catch (_) {
                    return undefined;
                }
            }
        });

        this.sock = sock;

        // Instance-level trackers.
        sock.myJid = this.myJid;
        sock.stormTracker = {};
        sock.presenceTracker = {};
        sock.alwaysOnlineTracker = 0;
        sock.spamTracker = {};
        sock.newsletterJid = this.newsletterJid;
        sock.newsletterName = this.newsletterName;

        // Attach the configured channel to outgoing messages.
        const originalSendMessage =
            sock.sendMessage.bind(sock);

        sock.sendMessage = async (
            jid,
            content,
            options = {}
        ) => {
            const settings = this.settingsManager.get();

            if (
                !settings.hideViewChannel &&
                this.newsletterJid
            ) {
                if (
                    content &&
                    typeof content === "object" &&
                    !content.delete &&
                    !content.react
                ) {
                    if (!content.contextInfo) {
                        content.contextInfo = {};
                    }

                    if (
                        !content.contextInfo
                            .forwardedNewsletterMessageInfo
                    ) {
                        content.contextInfo.forwardingScore = 999;
                        content.contextInfo.isForwarded = true;

                        content.contextInfo
                            .forwardedNewsletterMessageInfo = {
                                newsletterJid: this.newsletterJid,
                                newsletterName: this.newsletterName,
                                serverMessageId: 1
                            };
                    }
                }
            }

            return await originalSendMessage(
                jid,
                content,
                options
            );
        };

        // SESSION_ID watchdog.
        if (this.sessionId && !this.sessionIdInvalid) {
            const wdTimer = setTimeout(() => {
                if (!sock.user) {
                    console.log(
                        `[${this.userId}] SESSION_ID failed to connect within 30s. Enabling QR fallback.`
                    );

                    this.sessionIdFailed = true;
                }
            }, 30000);

            if (wdTimer.unref) wdTimer.unref();
        }

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on(
            "connection.update",
            async (update) => {
                const {
                    connection,
                    lastDisconnect,
                    qr
                } = update;

                if (qr) {
                    this.latestQr = qr;
                }

                // Request pairing code when WhatsApp emits QR.
                if (
                    qr &&
                    usePairingCode &&
                    this.pendingPairingNumber &&
                    !this.pairingCodeRequested
                ) {
                    this.pairingCodeRequested = true;

                    try {
                        await new Promise(resolve =>
                            setTimeout(resolve, 1500)
                        );

                        if (
                            this.sock !== sock ||
                            !this.pendingPairingNumber
                        ) {
                            throw new Error(
                                "Pairing socket was replaced; retry the request."
                            );
                        }

                        const pNum =
                            this.pendingPairingNumber.replace(
                                /[^0-9]/g,
                                ""
                            );

                        if (!/^\d{7,15}$/.test(pNum)) {
                            throw new Error(
                                "Invalid phone number for WhatsApp pairing."
                            );
                        }

                        const code =
                            await sock.requestPairingCode(pNum);

                        console.log(
                            `[${this.userId}] Pairing code: ${code}`
                        );

                        if (this.pairingCodeResolve) {
                            this.pairingCodeResolve(code);
                            this.pairingCodeResolve = null;
                            this.pairingCodeReject = null;
                        }

                        this.pendingPairingNumber = null;
                    } catch (err) {
                        console.error(
                            `[${this.userId}] Pairing code error:`,
                            err.message
                        );

                        if (this.pairingCodeReject) {
                            this.pairingCodeReject(err);
                            this.pairingCodeResolve = null;
                            this.pairingCodeReject = null;
                        }

                        this.pairingCodeRequested = false;
                    }
                }

                if (
    
