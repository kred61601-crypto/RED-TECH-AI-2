/**
 * botInstance — one WhatsApp connection per SaaS user.
 *
 * Scopes socket, QR, JID, settings, and store state to each user.
 * Message processing runs inside AsyncLocalStorage.run() so commands
 * transparently use the correct user's data.
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
const { handleVV2EmojiReply } = require("../lib/vv2EmojiTrigger");
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

        // Pairing state
        this.pairingCodeResolve = null;
        this.pairingCodeReject = null;
        this.pairingRestartInProgress = false;
        this.pairingCodeRequested = false;
        this.pendingPairingNumber = null;

        // Session state
        this.sessionIdFailed = false;
        this.sessionIdInvalid = false;
        this.sessionInvalidated = false;
        this.restoredFromDatabase = false;

        // Newsletter
        this.newsletterJid = "120363428521307680@newsletter";
        this.newsletterName = "Redtech Ai Updates";

        this.sessionId = options.sessionId || null;
    }

    // ── Context runner ──────────────────────────────────────────────

    _runInContext(fn) {
        const ctx = {
            store: this.store,
            settingsCache: this.settingsManager.get(),
            settingsManager: this.settingsManager,
            myJid: this.myJid
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
        const number = String(phone || "").replace(/[\s()+-]/g, "");

        if (!/^[1-9]\d{7,14}$/.test(number)) {
            return Promise.reject(new Error("Invalid phone number."));
        }

        if (this.pairingCodeResolve || this.pairingRestartInProgress) {
            return Promise.reject(
                new Error("A pairing request is already in progress.")
            );
        }

        if (this.status === "online") {
            return Promise.reject(
                new Error("This WhatsApp account is already connected.")
            );
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;

            const finish = (error, code) => {
                if (settled) return;
                settled = true;

                if (timer) clearTimeout(timer);

                this.pairingCodeResolve = null;
                this.pairingCodeReject = null;
                this.pendingPairingNumber = null;
                this.pairingCodeRequested = false;
                this.pairingRestartInProgress = false;

                if (error) reject(error);
                else resolve(code);
            };

            this.pairingCodeResolve = code => finish(null, code);

            this.pairingCodeReject = error => {
                finish(
                    error instanceof Error
                        ? error
                        : new Error(String(error || "Pairing failed."))
                );
            };

            timer = setTimeout(() => {
                finish(
                    new Error(
                        "Timed out waiting for the WhatsApp pairing code. Please try again."
                    )
                );
            }, 65000);

            if (timer.unref) timer.unref();

            this.pendingPairingNumber = number;
            this.pairingCodeRequested = false;
            this.pairingRestartInProgress = true;
            this.sessionIdFailed = false;
            this.stopped = false;

            // Never delete saved credentials just to request a pairing code.
            const oldSock = this.sock;
            this.sock = null;
            this.isReconnecting = false;

            if (oldSock) {
                try {
                    oldSock.end(
                        new Error("Restarting connection for pairing.")
                    );
                } catch (error) {
                    console.warn(
                        `[${this.userId}] Socket shutdown warning:`,
                        error.message
                    );
                }
            }

            setTimeout(async () => {
                if (settled || this.stopped) return;

                try {
                    this.isReconnecting = false;
                    await this._connectionLogic();
                } catch (error) {
                    finish(error);
                }
            }, 300);
        });
    }

    // ── Session utilities ───────────────────────────────────────────

    wipeSession() {
        try {
            if (fs.existsSync(this.sessionDir)) {
                fs.readdirSync(this.sessionDir).forEach(file => {
                    try {
                        fs.unlinkSync(path.join(this.sessionDir, file));
                    } catch (_) {}
                });
            }
        } catch (error) {
            console.error(
                `[${this.userId}] wipeSession error:`,
                error.message
            );
        }
    }

    getSessionId() {
        const credsPath = path.join(this.sessionDir, "creds.json");

        if (
            !fs.existsSync(credsPath) ||
            fs.statSync(credsPath).size < 10
        ) {
            return null;
        }

        const creds = fs.readFileSync(credsPath, "utf-8");

        return "REDTECH~" + Buffer.from(creds).toString("base64");
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
                        this.sessionInvalidated ? "invalid" : "timeout"
                    );
                }

                setTimeout(check, 250);
            };

            check();
        });
    }

    restoreSessionId(sessionId) {
        const rawId = String(sessionId || "").trim();
        const encoded = rawId.includes("~")
            ? rawId.split("~")[1]
            : rawId;

        if (!encoded) {
            throw new Error("Session ID is empty.");
        }

        const buffer = Buffer.from(encoded, "base64");

        const decodeBuffer = buf => {
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
            if (credsJson[i] !== "{") continue;

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
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        fs.writeFileSync(
            path.join(this.sessionDir, "creds.json"),
            JSON.stringify(creds)
        );
    }

    // ── Core connection logic ───────────────────────────────────────

    async _connectionLogic() {
        if (this.stopped || this.isReconnecting) return;

        this.isReconnecting = true;
        this.status = "connecting";

        // Restore credentials from SESSION_ID if needed.
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
                } catch (error) {
                    console.error(
                        `[${this.userId}] Session restore failed:`,
                        error.message
                    );
                }
            }
        }

        // Use MongoDB auth when configured; otherwise use local files.
        let authState;
        let usingDatabaseAuth = false;

        try {
            const { initDb, isOnline } = require("../firebox/db");

            await initDb();

            if (isOnline()) {
                const {
                    useDatabaseAuthState
                } = require("../firebox/dbAuth");

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

        if (this.stopped) {
            this.isReconnecting = false;
            return;
        }

        if (!authState) {
            authState = await useMultiFileAuthState(this.sessionDir);
        }

        let { state, saveCreds } = authState;

        this.restoredFromDatabase =
            usingDatabaseAuth && !!state.creds.registered;

        // Do not erase auth files while a pairing request is active.
        if (
            !this.hasWipedSessionOnStartup &&
            !state.creds.registered &&
            !this.sessionId &&
            !this.pendingPairingNumber
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

                const freshState = await useMultiFileAuthState(
                    this.sessionDir
                );

                state = freshState.state;
                saveCreds = freshState.saveCreds;
            } catch (error) {
                console.error(
                    `[${this.userId}] Failed to clean session folder:`,
                    error.message
                );
            }
        }

        // Existing registered credentials cannot request a new pairing code.
        // Preserve them instead of destroying a connected user's session.
        if (
            this.pendingPairingNumber &&
            state.creds.registered
        ) {
            const error = new Error(
                "This account already has saved WhatsApp credentials. " +
                "Use a new, separate session for a new pairing request; " +
                "saved credentials were preserved."
            );

            this.isReconnecting = false;
            this.status = "offline";

            if (this.pairingCodeReject) {
                this.pairingCodeReject(error);
            }

            return;
        }

        const usePairingCode =
            !!this.pendingPairingNumber &&
            !state.creds.registered;

        const msgRetryCounterCache = new NodeCache();
        const logger = P({ level: "silent" });

        let version = [2, 3000, 1017531287];

        try {
            const { version: latestVersion } =
                await fetchLatestBaileysVersion();

            version = latestVersion;
        } catch (_) {}

        if (this.stopped) {
            this.isReconnecting = false;
            return;
        }

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
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

            getMessage: async key => {
                try {
                    const {
                        getMessage: getMsg
                    } = require("../firebox/messageModel");

                    const msg = await getMsg(key.id);

                    return msg ? msg.content : undefined;
                } catch (_) {
                    return undefined;
                }
            }
        });

        this.sock = sock;

        // Per-instance command and automation trackers.
        sock.myJid = this.myJid;
        sock.stormTracker = {};
        sock.presenceTracker = {};
        sock.alwaysOnlineTracker = 0;
        sock.spamTracker = {};
        sock.newsletterJid = this.newsletterJid;
        sock.newsletterName = this.newsletterName;

        // Newsletter forwarding-label behavior.
        const originalSendMessage = sock.sendMessage.bind(sock);

        sock.sendMessage = async (jid, content, options = {}) => {
            const settings = this.settingsManager.get();

            if (
                !settings.hideViewChannel &&
                this.newsletterJid &&
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

            return originalSendMessage(jid, content, options);
        };

        // SESSION_ID watchdog.
        if (this.sessionId && !this.sessionIdInvalid) {
            const watchdogTimer = setTimeout(() => {
                if (!sock.user) {
                    console.log(
                        `[${this.userId}] SESSION_ID did not connect within 30 seconds.`
                    );

                    this.sessionIdFailed = true;
                }
            }, 30000);

            if (watchdogTimer.unref) watchdogTimer.unref();
        }

        sock.ev.on("creds.update", saveCreds);

        // ── Connection updates ──────────────────────────────────────

        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.latestQr = qr;
            }

            // Request a pairing code only when a QR event indicates that
            // WhatsApp has initialized the connection.
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

                    const phone = this.pendingPairingNumber.replace(
                        /[^0-9]/g,
                        ""
                    );

                    if (!/^\d{7,15}$/.test(phone)) {
                        throw new Error(
                            "Invalid phone number for WhatsApp pairing."
                        );
                    }

                    const code = await sock.requestPairingCode(phone);

                    console.log(
                        `[${this.userId}] Pairing code generated.`
                    );

                    if (this.pairingCodeResolve) {
                        this.pairingCodeResolve(code);
                        this.pairingCodeResolve = null;
                        this.pairingCodeReject = null;
                    }

                    this.pendingPairingNumber = null;
                } catch (error) {
                    console.error(
                        `[${this.userId}] Pairing code error:`,
                        error.message
                    );

                    if (this.pairingCodeReject) {
                        this.pairingCodeReject(error);
                        this.pairingCodeResolve = null;
                        this.pairingCodeReject = null;
                    }

                    this.pairingCodeRequested = false;
                }
            }

            if (
                qr &&
                (!this.sessionId || this.sessionIdFailed) &&
                !usePairingCode
            ) {
                console.log(
                    `[${this.userId}] QR code available.`
                );
            }

            // ── Connection opened ──────────────────────────────────

            if (connection === "open") {
                this.latestQr = null;
                this.isReconnecting = false;
                this.consecutiveFailures = 0;
                this.status = "online";
                this.botStartTime = Math.floor(Date.now() / 1000);

                console.log(
                    `[${this.userId}] Bot connected successfully.`
                );

                try {
                    const { initDb } = require("../redtech/db");
                    await initDb();
                } catch (_) {}

                await this._runInContext(async () => {
                    await this.settingsManager.load();
                });

                const settings = this.settingsManager.get();

                if (settings.alwaysOnline) {
                    await sock
                        .sendPresenceUpdate("available")
                        .catch(() => {});
                }

                if (this.alwaysOnlineInterval) {
                    clearInterval(this.alwaysOnlineInterval);
                }

                this.alwaysOnlineInterval = setInterval(async () => {
                    if (this.sock !== sock) return;

                    const currentSettings =
                        this.settingsManager.get();

                    if (currentSettings.alwaysOnline) {
                        await sock
                            .sendPresenceUpdate("available")
                            .catch(() => {});
                    }
                }, 15000);

                // Resolve newsletter JID.
                try {
                    const metadata = await sock
                        .newsletterMetadata(
                            "invite",
                            "0029VbCwmFXDzgT4FzZm6d28"
                        )
                        .catch(() => null);

                    if (metadata && metadata.id) {
                        this.newsletterJid = metadata.id;
                        this.newsletterName =
                            metadata.subject || "Redtech Ai Updates";

                        sock.newsletterJid = this.newsletterJid;
                        sock.newsletterName = this.newsletterName;
                    }
                } catch (_) {}

                // Record this connection's JID.
                const jid = (sock.user && sock.user.id) || "";
                const cleanJid = jid.split(":")[0];
                const domain = jid.includes("@lid")
                    ? "@lid"
                    : "@s.whatsapp.net";

                this.myJid = cleanJid
                    ? cleanJid + domain
                    : "";

                sock.myJid = this.myJid;

                console.log(
                    `[${this.userId}] Connected as ${this.myJid}`
                );

                // Health watchdog.
                if (this.healthCheckInterval) {
                    clearInterval(this.healthCheckInterval);
                }

                this.healthCheckInterval = setInterval(async () => {
                    if (this.sock !== sock || this.stopped) return;

                    try {
                        const wsOpen = sock &&
                            sock.ws &&
                            (
                                sock.ws.isOpen === true ||
                                sock.ws.readyState === 1 ||
                                (
                                    sock.ws.socket &&
                                    sock.ws.socket.readyState === 1
                                )
                            );

                        if (!wsOpen) {
                            throw new Error("WebSocket not open");
                        }

                        let timeout;

                        try {
                            await Promise.race([
                                sock.fetchBlocklist().catch(() => null),
                                new Promise((_, reject) => {
                                    timeout = setTimeout(
                                        () => reject(
                                            new Error("Health check timeout")
                                        ),
                                        15000
                                    );
                                })
                            ]);
                        } finally {
                            if (timeout) clearTimeout(timeout);
                        }
                    } catch (error) {
                        console.error(
                            `[${this.userId}] Health watchdog failed:`,
                            error.message
                        );

                        this._clearTimers();

                        try {
                            sock.end();
                        } catch (_) {}

                        this.status = "offline";
                        this.isReconnecting = false;

                        setTimeout(() => {
                            if (!this.stopped && this.sock === sock) {
                                this._connectionLogic().catch(err => {
                                    console.error(
                                        `[${this.userId}] Reconnect error:`,
                                        err.message
                                    );
                                });
                            }
                        }, 5000);
                    }
                }, 3 * 60 * 1000);
            }

            // ── Connection closed ───────────────────────────────────

            if (connection === "close") {
                this.isReconnecting = false;
                this.status = "offline";
                this._clearTimers();

                if (this.stopped) return;

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode ||
                    lastDisconnect?.error?.output?.payload?.statusCode;

                console.log(
                    `[${this.userId}] Disconnected. Status: ${statusCode}`
                );

                if (statusCode === DisconnectReason.loggedOut) {
                    // Clear credentials only when WhatsApp reports logout.
                    try {
                        const {
                            clearDatabaseAuthState
                        } = require("../firebox/dbAuth");

                        await clearDatabaseAuthState(
                            `saas_${this.userId}`
                        );
                    } catch (error) {
                        console.error(
                            `[${this.userId}] Failed to clear logged-out auth:`,
                            error.message
                        );
                    }

                    this.sessionId = null;
                    this.sessionIdInvalid = true;
                    this.sessionInvalidated = true;
                    this.wipeSession();
                    this.hasWipedSessionOnStartup = false;

                    console.log(
                        `[${this.userId}] Auth state cleared. Waiting for new pairing.`
                    );

                    return;
                }

                if (this.pairingRestartInProgress) {
                    setTimeout(() => {
                        if (!this.stopped) {
                            this._connectionLogic().catch(error => {
                                if (this.pairingCodeReject) {
                                    this.pairingCodeReject(error);
                                }
                            });
                        }
                    }, 2000);

                    return;
                }

                const isNetworkError =
                    lastDisconnect?.error?.code === "ENOTFOUND" ||
                    lastDisconnect?.error?.code === "EAI_AGAIN" ||
                    lastDisconnect?.error?.code === "ECONNREFUSED" ||
                    lastDisconnect?.error?.code === "ETIMEDOUT" ||
                    lastDisconnect?.error?.code === "ECONNRESET" ||
                    statusCode === DisconnectReason.connectionLost ||
                    statusCode === DisconnectReason.connectionClosed ||
                    statusCode === DisconnectReason.timedOut;

                if (!isNetworkError) {
                    this.consecutiveFailures++;
                }

                if (this.consecutiveFailures >= 5) {
                    this.consecutiveFailures = 0;
                    this.hasWipedSessionOnStartup = false;

                    if (this.sessionId) {
                        this.sessionIdInvalid = true;
                        this.sessionId = null;
                    }

                    // Avoid deleting a valid session solely because of
                    // a transient connection problem.
                    if (statusCode === DisconnectReason.loggedOut) {
                        this.wipeSession();
                    }

                    setTimeout(() => {
                        if (!this.stopped) {
                            this._connectionLogic().catch(error => {
                                console.error(
                                    `[${this.userId}] Reconnect failed:`,
                                    error.message
                                );
                            });
                        }
                    }, 5000);
                } else {
                    setTimeout(() => {
                        if (!this.stopped) {
                            this._connectionLogic().catch(error => {
                                console.error(
                                    `[${this.userId}] Reconnect failed:`,
                                    error.message
                                );
                            });
                        }
                    }, 10000);
                }
            }
        });

        // ── Incoming messages ───────────────────────────────────────

        sock.ev.on("messages.upsert", async upsert => {
            if (upsert.type !== "notify") return;

            const message = upsert.messages?.[0];

            if (!message?.message) return;

            const messageTime = message.messageTimestamp
                ? Number(message.messageTimestamp)
                : 0;

            if (
                this.botStartTime &&
                messageTime &&
                messageTime < this.botStartTime
            ) {
                return;
            }

            await this._runInContext(async () => {
                // VV2 reactions are independently configurable per user.
                try {
                    const vv2Enabled =
                        this.store.get("vv2_enabled", false) === true;

                    if (vv2Enabled) {
                        await handleVV2EmojiReply(
                            sock,
                            message,
                            { enabled: true }
                        );
                    }
                } catch (error) {
                    console.error(
                        `[${this.userId}] VV2 trigger error:`,
                        error.message
                    );
                }

                try {
                    await handleAutomation(sock, message);
                } catch (error) {
                    console.error(
                        `[${this.userId}] Automation error:`,
                        error.message
                    );
                }

                try {
                    await handleMessages(sock, upsert);
                } catch (error) {
                    console.error(
                        `[${this.userId}] Message handler error:`,
                        error.message
                    );
                }
            });
        });

        // ── Message updates / anti-delete ──────────────────────────

        sock.ev.on("messages.update", async update => {
            try {
                await this._runInContext(async () => {
                    await handleMessageDelete(sock, update);
                });
            } catch (error) {
                console.error(
                    `[${this.userId}] Message update error:`,
                    error.message
                );
            }
        });

        // ── Anti-call ───────────────────────────────────────────────

        sock.ev.on("call", async calls => {
            const settings = this.settingsManager.get();

            if (!settings.antiCall) return;

            for (const call of calls) {
                if (call.status === "offer") {
                    await sock
                        .rejectCall(call.id, call.from)
                        .catch(() => {});
                }
            }
        });

        // ── Group welcome / goodbye events ──────────────────────────

        sock.ev.on("group-participants.update", async update => {
            try {
                const { id, participants, action } = update;
                const settings = this.settingsManager.get();

                const localMode = this.store.get(
                    `events_mode_${id}`,
                    null
                );

                const isActive = localMode !== null
                    ? localMode === "on"
                    : settings.groupEventsGlobal;

                if (!isActive) return;

                const metadata = await sock
                    .groupMetadata(id)
                    .catch(() => null);

                if (!metadata) return;

                const groupName = metadata.subject || "";
                const memberCount =
                    metadata.participants?.length || 0;

                for (const participant of participants) {
                    const userMention =
                        `@${participant.split("@")[0]}`;

                    if (action === "add") {
                        const template = this.store.get(
                            `welcome_msg_${id}`,
                            null
                        ) || settings.welcomeMsg;

                        const messageText = String(template || "")
                            .replace(/@user/g, userMention)
                            .replace(/@group/g, groupName)
                            .replace(/{count}/g, String(memberCount));

                        await sock.sendMessage(id, {
                            text: messageText,
                            mentions: [participant]
                        }).catch(() => {});
                    } else if (action === "remove") {
                        const template = this.store.get(
                            `goodbye_msg_${id}`,
                            null
                        ) || settings.goodbyeMsg;

                        const messageText = String(template || "")
                            .replace(/@user/g, userMention)
                            .replace(/@group/g, groupName);

                        await sock.sendMessage(id, {
                            text: messageText,
                            mentions: [participant]
                        }).catch(() => {});
                    }
                }
            } catch (error) {
                console.error(
                    `[${this.userId}] Group participants error:`,
                    error.message
                );
            }
        });
    }

    // ── Cleanup timers ──────────────────────────────────────────────

    _clearTimers() {
        if (this.alwaysOnlineInterval) {
            clearInterval(this.alwaysOnlineInterval);
            this.alwaysOnlineInterval = null;
        }

        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }
}

module.exports = BotInstance;
