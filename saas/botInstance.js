
/**
 * botInstance — one WhatsApp connection per SaaS user.
 *
 * Each SaaS user has their own WhatsApp connection and JSON store.
 * Message processing runs inside AsyncLocalStorage context.
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

        // Newsletter
        this.newsletterJid = "120363428521307680@newsletter";
        this.newsletterName = "Redtech Ai Updates";

        // User's WhatsApp session
        this.sessionId = options.sessionId || null;
    }

    // ── Per-user context ────────────────────────────────────────────────

    _runInContext(fn) {
        const ctx = {
            store: this.store,
            settingsCache: this.settingsManager.get(),
            settingsManager: this.settingsManager,
            myJid: this.myJid
        };

        return botContext.run(ctx, fn);
    }

    // ── Start ───────────────────────────────────────────────────────────

    async start() {
        this.stopped = false;
        this.sessionInvalidated = false;

        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }

        await this.settingsManager.load();
        await this._connectionLogic();
    }

    // ── Stop ────────────────────────────────────────────────────────────

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

    // ── Pairing trigger ─────────────────────────────────────────────────

    triggerPairingRestart(phone) {
        return new Promise((resolve, reject) => {
            this.pairingCodeResolve = resolve;
            this.pairingCodeReject = reject;

            const timer = setTimeout(() => {
                if (this.pairingCodeResolve === resolve) {
                    this.pairingCodeResolve = null;
                    this.pairingCodeReject = null;

                    reject(
                        new Error("Timed out waiting for pairing code (15s).")
                    );
                }
            }, 25000);

            if (timer.unref) timer.unref();

            this.pendingPairingNumber = phone;
            this.pairingCodeRequested = false;
            this.sessionId = null;
            this.sessionIdFailed = false;

            // Clear stale session files before a new pairing.
            try {
                if (fs.existsSync(this.sessionDir)) {
                    fs.readdirSync(this.sessionDir).forEach(file => {
                        try {
                            fs.unlinkSync(path.join(this.sessionDir, file));
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
        const rawId = sessionId.trim();
        const encoded = rawId.includes("~")
            ? rawId.split("~")[1]
            : rawId;

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
        const creds = parsed.creds || (parsed.noiseKey ? parsed : null);

        if (!creds) {
            throw new Error("No credentials found inside Session ID.");
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

    // ── Core connection logic ───────────────────────────────────────────

    async _connectionLogic() {
        if (this.stopped || this.isReconnecting) return;

        this.isReconnecting = true;
        this.status = "connecting";

        // Restore SESSION_ID if needed.
        if (this.sessionId && !this.sessionIdInvalid) {
            const credsPath = path.join(this.sessionDir, "creds.json");

            const sessionExists =
                fs.existsSync(credsPath) &&
                fs.statSync(credsPath).size > 10;

            if (!sessionExists) {
                console.log(
                    `[${this.userId}] Restoring session from SESSION_ID...`
                );

                try {
                    this.restoreSessionId(this.sessionId);
                    console.log(`[${this.userId}] Session restored.`);
                } catch (error) {
                    console.error(
                        `[${this.userId}] Session restore failed:`,
                        error.message
                    );
                }
            }
        }

        // MongoDB auth state, with local multi-file fallback.
        let authState;
        let usingDatabaseAuth = false;

        try {
            const { initDb, isOnline } = require("../firebox/db");

            await initDb();

            if (isOnline()) {
                const { useDatabaseAuthState } =
                    require("../firebox/dbAuth");

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
                            fs.unlinkSync(path.join(this.sessionDir, file));
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

        const usePairingCode =
            !!this.pendingPairingNumber && !state.creds.registered;

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
                keys: makeCacheableSignalKeyStore(state.keys, logger)
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
                    const { getMessage: getMsg } =
                        require("../firebox/messageModel");

                    const message = await getMsg(key.id);

                    return message ? message.content : undefined;
                } catch (_) {
                    return undefined;
                }
            }
        });

        this.sock = sock;

        sock.myJid = this.myJid;
        sock.stormTracker = {};
        sock.presenceTracker = {};
        sock.alwaysOnlineTracker = 0;
        sock.spamTracker = {};
        sock.newsletterJid = this.newsletterJid;
        sock.newsletterName = this.newsletterName;

        // Preserve the existing newsletter forwarding-label behavior.
        const originalSendMessage = sock.sendMessage.bind(sock);

        sock.sendMessage = async (jid, content, options = {}) => {
            const settings = this.settingsManager.get();

            if (!settings.hideViewChannel && this.newsletterJid) {
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

            return originalSendMessage(jid, content, options);
        };

        // SESSION_ID watchdog.
        if (this.sessionId && !this.sessionIdInvalid) {
            const watchdog = setTimeout(() => {
                if (!sock.user) {
                    console.log(
                        `[${this.userId}] Session ID failed within 30s.`
                    );

                    this.sessionIdFailed = true;
                }
            }, 30000);

            if (watchdog.unref) watchdog.unref();
        }

        sock.ev.on("creds.update", saveCreds);

        // ── Connection events ──────────────────────────────────────────

        sock.ev.on("connection.update", async update => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) this.latestQr = qr;

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

                    const number = this.pendingPairingNumber.replace(
                        /[^0-9]/g,
                        ""
                    );

                    if (!/^\d{7,15}$/.test(number)) {
                        throw new Error(
                            "Invalid phone number for WhatsApp pairing."
                        );
                    }

                    const code = await sock.requestPairingCode(number);

                    console.log(
                        `[${this.userId}] Pairing code: ${code}`
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
                    `[${this.userId}] QR code available`
                );
            }

            if (connection === "open") {
                this.latestQr = null;
                this.isReconnecting = false;
                this.consecutiveFailures = 0;
                this.status = "online";
                this.botStartTime = Math.floor(Date.now() / 1000);

                console.log(`[${this.userId}] Bot connected!`);

                try {
                    const { initDb } = require("../redtech/db");
                    await initDb();
                } catch (_) {}

                await this._runInContext(async () => {
                    await this.settingsManager.load();
                });

                const settings = this.settingsManager.get();

                if (settings.alwaysOnline) {
                    await sock.sendPresenceUpdate("available")
                        .catch(() => {});
                }

                if (this.alwaysOnlineInterval) {
                    clearInterval(this.alwaysOnlineInterval);
                }

                this.alwaysOnlineInterval = setInterval(async () => {
                    const currentSettings = this.settingsManager.get();

                    if (currentSettings.alwaysOnline) {
                        await sock.sendPresenceUpdate("available")
                            .catch(() => {});
                    }
                }, 15000);

                // Resolve newsletter JID.
                try {
                    const metadata = await sock.newsletterMetadata(
                        "invite",
                        "0029VbCwmFXDzgT4FzZm6d28"
                    ).catch(() => null);

                    if (metadata?.id) {
                        this.newsletterJid = metadata.id;
                        this.newsletterName =
                            metadata.subject || "Redtech Ai Updates";

                        sock.newsletterJid = this.newsletterJid;
                        sock.newsletterName = this.newsletterName;
                    }
                } catch (_) {}

                // Set connected account JID.
                const myJid = (sock.user && sock.user.id) || "";
                const cleanJid = myJid.split(":")[0];
                const domain = myJid.includes("@lid")
                    ? "@lid"
                    : "@s.whatsapp.net";

                this.myJid = cleanJid ? cleanJid + domain : "";
                sock.myJid = this.myJid;

                console.log(
                    `[${this.userId}] Connected as ${this.myJid}`
                );

                // Health watchdog.
                if (this.healthCheckInterval) {
                    clearInterval(this.healthCheckInterval);
                }

                this.healthCheckInterval = setInterval(async () => {
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

                        await Promise.race([
                            sock.fetchBlocklist().catch(() => null),
                            new Promise((_, reject) =>
                                setTimeout(
                                    () => reject(new Error("timeout")),
                                    15000
                                )
                            )
                        ]);
                    } catch (error) {
                        console.error(
                            `[${this.userId}] Watchdog failed:`,
                            error.message
                        );

                        this._clearTimers();

                        try {
                            sock.end();
                        } catch (_) {}

                        this.status = "offline";
                        this.isReconnecting = false;

                        setTimeout(
                            () => this._connectionLogic(),
                            5000
                        );
                    }
                }, 3 * 60 * 1000);
            }

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
                    try {
                        const { clearDatabaseAuthState } =
                            require("../firebox/dbAuth");

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
                        `[${this.userId}] Auth cleared. Waiting for pairing.`
                    );

                    return;
                }

                if (this.pairingRestartInProgress) {
                    this.pairingRestartInProgress = false;

                    setTimeout(
                        () => this._connectionLogic(),
                        2000
                    );

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

                    this.wipeSession();

                    setTimeout(
                        () => this._connectionLogic(),
                        5000
                    );
                } else {
                    setTimeout(
                        () => this._connectionLogic(),
                        10000
                    );
                }
            }
        });

        // ── Message events + VV2 emoji trigger ──────────────────────────

        sock.ev.on("messages.upsert", async upsert => {
            if (upsert.type !== "notify") return;

            const m = upsert.messages?.[0];

            if (!m?.message) return;

            const msgTime = m.messageTimestamp
                ? Number(m.messageTimestamp)
                : 0;

            if (
                this.botStartTime &&
                msgTime &&
                msgTime < this.botStartTime
            ) {
                return;
            }

            // IMPORTANT: run all per-user operations in the user's context.
            await this._runInContext(async () => {
                try {
                    const vv2Enabled =
                        this.store.get("vv2_enabled", false) === true;

                    if (vv2Enabled) {
                        await handleVV2EmojiReply(sock, m, {
                            enabled: true
                        });
                    }
                } catch (error) {
                    console.error(
                        `[${this.userId}] VV2 trigger error:`,
                        error.message
                    );
                }

                try {
                    await handleAutomation(sock, m);
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

        // ── Message delete/update events ────────────────────────────────

        sock.ev.on("messages.update", async update => {
            this._runInContext(() =>
                handleMessageDelete(sock, update)
            );
        });

        // ── Anti-call ───────────────────────────────────────────────────

        sock.ev.on("call", async calls => {
            const settings = this.settingsManager.get();

            if (settings.antiCall) {
                for (const call of calls) {
                    if (call.status === "offer") {
                        await sock.rejectCall(call.id, call.from)
                            .catch(() => {});
                    }
                }
            }
        });

        // ── Group welcome/goodbye events ────────────────────────────────

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

                const metadata = await sock.groupMetadata(id)
                    .catch(() => null);

                if (!metadata) return;

                const groupName = metadata.subject || "";
                const memberCount =
                    metadata.participants?.length || 0;

                for (const participant of participants) {
                    const userMention =
                        `@${participant.split("@")[0]}`;

                    if (action === "add") {
                        const template =
                            this.store.get(`welcome_msg_${id}`, null) ||
                            settings.welcomeMsg;

                        const message = template
                            .replace(/@user/g, userMention)
                            .replace(/@group/g, groupName)
                            .replace(/{count}/g, memberCount);

                        await sock.sendMessage(id, {
                            text: message,
                            mentions: [participant]
                        }).catch(() => {});
                    } else if (action === "remove") {
                        const template =
                            this.store.get(`goodbye_msg_${id}`, null) ||
                            settings.goodbyeMsg;

                        const message = template
                            .replace(/@user/g, userMention)
                            .replace(/@group/g, groupName);

                        await sock.sendMessage(id, {
                            text: message,
                            mentions: [participant]
                        }).catch(() => {});
                    }
                }
            } catch (error) {
                console.error(
                    `[${this.userId}] group-participants error:`,
                    error.message
                );
            }
        });
    }

    // ── Clear timers ────────────────────────────────────────────────────

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
