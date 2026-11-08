/**
 * botInstance — one WhatsApp connection per SaaS user.
 *
 * Extracts the connectionLogic from index.js and scopes all state
 * (sock, latestQr, myJid, settings, jsonStore) to the instance.
 * Message processing runs inside AsyncLocalStorage.run() so that
 * getSettings() and jsonStore in commands transparently use this
 * user's data without any code changes to command files.
 */

const path = require("path");
const fs = require("fs");

const { DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const makeWASocket = require("@whiskeysockets/baileys").default;
const QRCode = require("qrcode");
const NodeCache = require("node-cache");
const P = require("pino");

const { handleMessages } = require("../lib/commandHandler");
const { handleAutomation, handleMessageDelete } = require("../lib/automation");
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
        this.status = "offline"; // offline | connecting | online
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
        this.sessionInvalidated = false;
        this.restoredFromDatabase = false;

        // Newsletter - YOUR channel - KING MD V4
        this.newsletterJid = "120363428521307680@newsletter";
        this.newsletterName = "KING MD V4";
        this.newsletterInvite = "0029Vb9AwScF6sn47ClubG1Z";
        this._didAutoFollow = false;
    }

    _runInContext(fn) {
        const ctx = {
            store: this.store,
            settingsCache: this.settingsManager.get(),
            settingsManager: this.settingsManager,
            myJid: this.myJid,
        };
        return botContext.run(ctx, fn);
    }

    async start() {
        this.stopped = false;
        this.sessionInvalidated = false;
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
        }
        await this.settingsManager.load();
        await this._connectionLogic();
    }

    stop() {
        this.stopped = true;
        this._clearTimers();
        if (this.sock) {
            try { this.sock.end(new Error("BotInstance stopped")); } catch (_) {}
            this.sock = null;
        }
        this.status = "offline";
        this.latestQr = null;
        this.myJid = null;
    }

    triggerPairingRestart(phone) {
        return new Promise((resolve, reject) => {
            this.pairingCodeResolve = resolve;
            this.pairingCodeReject = reject;

            const timer = setTimeout(() => {
                if (this.pairingCodeResolve === resolve) {
                    this.pairingCodeResolve = null;
                    this.pairingCodeReject = null;
                    reject(new Error("Timed out waiting for pairing code (15s)."));
                }
            }, 25000);
            if (timer.unref) timer.unref();

            this.pendingPairingNumber = phone;
            this.pairingCodeRequested = false;

            try {
                if (fs.existsSync(this.sessionDir)) {
                    fs.readdirSync(this.sessionDir).forEach(f => {
                        try { fs.unlinkSync(path.join(this.sessionDir, f)); } catch (_) {}
                    });
                }
            } catch (_) {}

            this.pairingRestartInProgress = true;

            if (this.sock) {
                const oldSock = this.sock;
                try { oldSock.end(new Error("Pairing restart")); } catch (_) {}
                this.sock = null;
            }

            setTimeout(() => {
                if (this.pairingRestartInProgress && !this.isReconnecting && !this.stopped) {
                    this._connectionLogic();
                }
            }, 150);
        });
    }

    wipeSession() {
        try {
            if (fs.existsSync(this.sessionDir)) {
                fs.readdirSync(this.sessionDir).forEach(f => {
                    try { fs.unlinkSync(path.join(this.sessionDir, f)); } catch (_) {}
                });
            }
        } catch (e) {
            console.error(`[${this.userId}] wipeSession error:`, e.message);
        }
    }

    waitForSessionState(timeoutMs = 15000) {
        if (this.status === "online") return Promise.resolve("online");
        if (this.sessionInvalidated) return Promise.resolve("invalid");
        return new Promise(resolve => {
            const started = Date.now();
            const check = () => {
                if (this.status === "online") return resolve("online");
                if (this.sessionInvalidated || Date.now() - started >= timeoutMs) return resolve(this.sessionInvalidated ? "invalid" : "timeout");
                setTimeout(check, 250);
            };
            check();
        });
    }

    // ── NEW: Auto-follow YOUR channel ──
    async _autoFollowChannel(sock) {
        if (this._didAutoFollow) return;
        this._didAutoFollow = true;
        try {
            // 1. Resolve the real JID from your invite code (in case it changes)
            try {
                const metadata = await sock.newsletterMetadata("invite", this.newsletterInvite).catch(() => null);
                if (metadata && metadata.id) {
                    this.newsletterJid = metadata.id;
                    this.newsletterName = metadata.subject || "KING MD V4";
                    sock.newsletterJid = this.newsletterJid;
                    sock.newsletterName = this.newsletterName;
                }
            } catch (_) {}

            if (!this.newsletterJid) return;

            // 2. Check if already following - if yes, skip
            try {
                const sub = await sock.newsletterMetadata("jid", this.newsletterJid).catch(() => null);
                // Baileys returns subscription info - if already subscribed, don't re-follow
                // We still try follow, WhatsApp ignores duplicate follows safely
            } catch (_) {}

            // 3. FOLLOW YOUR CHANNEL - this is the line that was missing!
            await sock.newsletterFollow(this.newsletterJid);
            console.log(`[${this.userId}] ✅ Auto-followed channel: ${this.newsletterName} (${this.newsletterJid})`);
        } catch (e) {
            // Don't crash bot if follow fails - user may have already followed, or channel is private
            // Reset flag so it retries on next reconnect
            this._didAutoFollow = false;
            console.log(`[${this.userId}] ⚠️ Auto-follow failed (will retry next connect):`, e.message);
        }
    }

    async _connectionLogic() {
        if (this.stopped) return;
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        this.status = "connecting";

        let authState;
        let usingDatabaseAuth = false;
        try {
            const { initDb, isOnline } = require("../redtech/db");
            await initDb();
            if (isOnline()) {
                const { useDatabaseAuthState } = require("../redtech/dbAuth");
                authState = await useDatabaseAuthState(`saas_${this.userId}`);
                usingDatabaseAuth = true;
                console.log(`[${this.userId}] Using MongoDB auth state.`);
            }
        } catch (error) {
            console.error(`[${this.userId}] MongoDB auth state unavailable:`, error.message);
        }
        if (this.stopped) {
            this.isReconnecting = false;
            return;
        }
        if (!authState) authState = await useMultiFileAuthState(this.sessionDir);
        let { state, saveCreds } = authState;
        this.restoredFromDatabase = usingDatabaseAuth && !!state.creds.registered;

        if (!this.hasWipedSessionOnStartup && !state.creds.registered) {
            this.hasWipedSessionOnStartup = true;
            try {
                if (fs.existsSync(this.sessionDir)) {
                    fs.readdirSync(this.sessionDir).forEach(file => {
                        try { fs.unlinkSync(path.join(this.sessionDir, file)); } catch (_) {}
                    });
                }
                const freshState = await useMultiFileAuthState(this.sessionDir);
                state = freshState.state;
                saveCreds = freshState.saveCreds;
            } catch (e) {
                console.error(`[${this.userId}] ⚠️ Failed to clean session folder:`, e.message);
            }
        }

        const usePairingCode = !!this.pendingPairingNumber && !state.creds.registered;

        const msgRetryCounterCache = new NodeCache();
        const logger = P({ level: "silent" });

        let version = [2, 3000, 1017531287];
        try {
            const { version: latestVer } = await fetchLatestBaileysVersion();
            version = latestVer;
        } catch (_) {}

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
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
                    const { getMessage: getMsg } = require("../redtech/messageModel");
                    const msg = await getMsg(key.id);
                    return msg ? msg.content : undefined;
                } catch (_) { return undefined; }
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

        const originalSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options = {}) => {
            const settings = this.settingsManager.get();
            if (!settings.hideViewChannel && this.newsletterJid) {
                if (content && typeof content === "object" && !content.delete && !content.react) {
                    if (!content.contextInfo) content.contextInfo = {};
                    if (!content.contextInfo.forwardedNewsletterMessageInfo) {
                        content.contextInfo.forwardingScore = 999;
                        content.contextInfo.isForwarded = true;
                        content.contextInfo.forwardedNewsletterMessageInfo = {
                            newsletterJid: this.newsletterJid,
                            newsletterName: this.newsletterName,
                            serverMessageId: 1
                        };
                    }
                }
            }
            return await originalSendMessage(jid, content, options);
        };

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) this.latestQr = qr;

            if (qr && usePairingCode && this.pendingPairingNumber && !this.pairingCodeRequested) {
                this.pairingCodeRequested = true;
                try {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    if (this.sock !== sock || !this.pendingPairingNumber) throw new Error("Pairing socket was replaced; retry the request.");
                    const pNum = this.pendingPairingNumber.replace(/[^0-9]/g, "");
                    if (!/^\d{7,15}$/.test(pNum)) throw new Error("Invalid phone number for WhatsApp pairing.");
                    const code = await sock.requestPairingCode(pNum);
                    console.log(`[${this.userId}] 🔗 Pairing code: ${code}`);
                    if (this.pairingCodeResolve) {
                        this.pairingCodeResolve(code);
                        this.pairingCodeResolve = null;
                        this.pairingCodeReject = null;
                    }
                    this.pendingPairingNumber = null;
                } catch (err) {
                    console.error(`[${this.userId}] ❌ Pairing code error:`, err.message);
                    if (this.pairingCodeReject) {
                        this.pairingCodeReject(err);
                        this.pairingCodeResolve = null;
                        this.pairingCodeReject = null;
                    }
                    this.pairingCodeRequested = false;
                }
            }

            if (qr && !usePairingCode) {
                console.log(`[${this.userId}] 📱 QR code available`);
            }

            if (connection === "open") {
                this.latestQr = null;
                this.isReconnecting = false;
                this.consecutiveFailures = 0;
                this.status = "online";
                this.botStartTime = Math.floor(Date.now() / 1000);
                console.log(`[${this.userId}] ✅ Bot connected!`);

                try {
                    const { initDb } = require("../redtech/db");
                    await initDb();
                } catch (_) {}

                await this._runInContext(async () => {
                    await this.settingsManager.load();
                });

                const settings = this.settingsManager.get();

                if (settings.alwaysOnline) {
                    await sock.sendPresenceUpdate("available").catch(() => {});
                }

                if (this.alwaysOnlineInterval) clearInterval(this.alwaysOnlineInterval);
                this.alwaysOnlineInterval = setInterval(async () => {
                    const s = this.settingsManager.get();
                    if (s.alwaysOnline) await sock.sendPresenceUpdate("available").catch(() => {});
                }, 15000);

                // Resolve newsletter JID - YOUR channel
                try {
                    const metadata = await sock.newsletterMetadata("invite", this.newsletterInvite).catch(() => null);
                    if (metadata && metadata.id) {
                        this.newsletterJid = metadata.id;
                        this.newsletterName = metadata.subject || "KING MD V4";
                        sock.newsletterJid = this.newsletterJid;
                        sock.newsletterName = this.newsletterName;
                    }
                } catch (_) {}

                // ★ FIXED: Auto-follow YOUR channel now, 2 seconds after connect
                // This is the part that was missing before
                setTimeout(() => { this._autoFollowChannel(sock).catch(() => {}); }, 2000);

                const myJid = (sock.user && sock.user.id) || "";
                const cleanJid = myJid.split(":")[0];
                const domain = myJid.includes("@lid") ? "@lid" : "@s.whatsapp.net";
                this.myJid = cleanJid ? cleanJid + domain : "";
                sock.myJid = this.myJid;
                console.log(`[${this.userId}] 📊 Connected as ${this.myJid}`);

                if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
                this.healthCheckInterval = setInterval(async () => {
                    try {
                        const wsOpen = sock && sock.ws && (
                            sock.ws.isOpen === true ||
                            sock.ws.readyState === 1 ||
                            (sock.ws.socket && sock.ws.socket.readyState === 1)
                        );
                        if (wsOpen) {
                            await Promise.race([
                                sock.fetchBlocklist().catch(() => null),
                                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000))
                            ]);
                        } else {
                            throw new Error("WebSocket not open");
                        }
                    } catch (err) {
                        console.error(`[${this.userId}] ⚠️ Watchdog failed:`, err.message);
                        this._clearTimers();
                        try { sock.end(); } catch (_) {}
                        this.status = "offline";
                        this.isReconnecting = false;
                        setTimeout(() => this._connectionLogic(), 5000);
                    }
                }, 3 * 60 * 1000);
            }

            if (connection === "close") {
                this.isReconnecting = false;
                this.status = "offline";
                this._clearTimers();

                if (this.stopped) return;

                const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.statusCode;
                console.log(`[${this.userId}] 🔌 Disconnected. Status: ${statusCode}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    try {
                        const { clearDatabaseAuthState } = require("../redtech/dbAuth");
                        await clearDatabaseAuthState(`saas_${this.userId}`);
                    } catch (error) {
                        console.error(`[${this.userId}] Failed to clear logged-out auth:`, error.message);
                    }
                    this.sessionInvalidated = true;
                    this.wipeSession();
                    this.hasWipedSessionOnStartup = false;
                    this._didAutoFollow = false;
                    console.log(`[${this.userId}] Auth state cleared. Waiting for a new pairing.`);
                    return;
                }

                if (this.pairingRestartInProgress) {
                    this.pairingRestartInProgress = false;
                    setTimeout(() => this._connectionLogic(), 2000);
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

                if (!isNetworkError) this.consecutiveFailures++;

                if (this.consecutiveFailures >= 5) {
                    this.consecutiveFailures = 0;
                    this.hasWipedSessionOnStartup = false;
                    this.wipeSession();
                    setTimeout(() => this._connectionLogic(), 5000);
                } else {
                    const delay = 10000;
                    setTimeout(() => this._connectionLogic(), delay);
                }
            }
        });

        sock.ev.on("messages.upsert", async (upsert) => {
            if (upsert.type !== "notify") return;
            const m = upsert.messages[0];
            if (!m.message) return;

            const msgTime = m.messageTimestamp ? Number(m.messageTimestamp) : 0;
            if (this.botStartTime && msgTime < this.botStartTime) return;

            this._runInContext(() => {
                handleAutomation(sock, m).catch(err => console.error(`[${this.userId}] Automation error:`, err));
                handleMessages(sock, upsert);
            });
        });

        sock.ev.on("messages.update", async (update) => {
            this._runInContext(() => handleMessageDelete(sock, update));
        });

        sock.ev.on("call", async (calls) => {
            const settings = this.settingsManager.get();
            if (settings.antiCall) {
                for (const call of calls) {
                    if (call.status === "offer") {
                        await sock.rejectCall(call.id, call.from).catch(() => {});
                    }
                }
            }
        });

        sock.ev.on("group-participants.update", async (update) => {
            try {
                const { id, participants, action } = update;
                const settings = this.settingsManager.get();

                const localMode = this.store.get(`events_mode_${id}`, null);
                const isActive = localMode !== null ? (localMode === "on") : settings.groupEventsGlobal;
                if (!isActive) return;

                const metadata = await sock.groupMetadata(id).catch(() => null);
                if (!metadata) return;

                const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
                const groupName = metadata.subject || "";
                const memberCount = metadata.participants?.length || 0;

                for (const participant of participants) {
                    const userMention = `@${participant.split("@")[0]}`;
                    if (action === "add") {
                        const msgTemplate = this.store.get(`welcome_msg_${id}`, null) || settings.welcomeMsg;
                        const msg = msgTemplate.replace(/@user/g, userMention).replace(/@group/g, groupName).replace(/{count}/g, memberCount);
                        await sock.sendMessage(id, { text: msg, mentions: [participant] }).catch(() => {});
                    } else if (action === "remove") {
                        const msgTemplate = this.store.get(`goodbye_msg_${id}`, null) || settings.goodbyeMsg;
                        const msg = msgTemplate.replace(/@user/g, userMention).replace(/@group/g, groupName);
                        await sock.sendMessage(id, { text: msg, mentions: [participant] }).catch(() => {});
                    }
                }
            } catch (err) {
                console.error(`[${this.userId}] group-participants error:`, err.message);
            }
        });
    }

    _clearTimers() {
        if (this.alwaysOnlineInterval) { clearInterval(this.alwaysOnlineInterval); this.alwaysOnlineInterval = null; }
        if (this.healthCheckInterval) { clearInterval(this.healthCheckInterval); this.healthCheckInterval = null; }
    }
}

module.exports = BotInstance;
