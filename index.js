const path = require("path");
const fireboxWebhook = require("./sasa/fireboxWebhook");
const { isAdminAuthenticated } = require("./sasa/adminAuth");
const botManager = require("./sasa/botManager");

const _origError = console.error.bind(console);
const _origLog = console.log.bind(console);

const CLEAN_SIGNAL_ERRORS = [
    { match: "Bad MAC", msg: "⚠️ [Signal] Corrupt session key — will auto-refresh." },
    { match: "No matching sessions found", msg: "⚠️ [Signal] No session found — awaiting key exchange." },
    { match: "No session found to decrypt", msg: "⚠️ [Signal] Missing sender key — will resolve automatically." },
    { match: "Failed to decrypt message with any known session", msg: "⚠️ [Signal] All session keys failed." },
    { match: "Closing open session in favor of incoming prekey", msg: "ℹ️ [Signal] Re-keying session." },
    { match: "Closing session:", msg: "ℹ️ [Signal] Closing stale session." },
    { match: "Decrypted message with closed session", msg: "ℹ️ [Signal] Decrypted via closed session (harmless)." },
    { match: "transaction failed, rolling back", msg: "⚠️ [Signal] Transaction rollback (non-fatal)." },
    { match: "_chains", msg: null },
    { match: "registrationId", msg: null },
    { match: "currentRatchet", msg: null },
    { match: "pendingPreKey", msg: null },
    { match: "indexInfo", msg: null },
    { match: "baseKeyType", msg: null },
    { match: "ephemeralKeyPair",msg: null },
];

const _logCooldowns = new Map();
const COOLDOWN_MS = 30_000;

function interceptLog(originalFn, args) {
    const raw = String(args[0]?? "");
    for (const { match, msg } of CLEAN_SIGNAL_ERRORS) {
        if (raw.includes(match)) {
            if (msg === null) return;
            const now = Date.now();
            if (now - (_logCooldowns.get(match) || 0) >= COOLDOWN_MS) {
                _logCooldowns.set(match, now);
                _origLog(msg);
            }
            return;
        }
    }
    originalFn(...args);
}

console.error = (...args) => interceptLog(_origError, args);
console.log = (...args) => interceptLog(_origLog, args);

process.on("unhandledRejection", (reason) => _origError("⚠️ Unhandled Rejection:", reason));
process.on("uncaughtException", (error) => _origError("⚠️ Uncaught Exception:", error));

const express = require("express");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000,
    },
}));

app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.use("/api/auth", require("./sasa/authApiRoutes"));
app.use("/api/admin", require("./sasa/adminApiRoutes"));
app.use("/api/bot", require("./sasa/userApiRoutes"));
const { createDatabaseApiRouter } = require("./sasa/fireboxDatabaseApi");
const { requireAdmin } = require("./sasa/adminAuth");
app.use("/api/firebox-database/v1", createDatabaseApiRouter());
app.use("/api/firebox/database", createDatabaseApiRouter());
app.use("/api/admin/firebox-database", require("./sasa/fireboxDatabaseApi").createAdminRouter(requireAdmin));

const tokenWorkspace = path.join(__dirname, "public", "token.html");
const codeWorkspace = path.join(__dirname, "public", "code.html");
const adminWorkspace = path.join(__dirname, "public", "admin.html");
const adminAccessWorkspace = path.join(__dirname, "public", "admin-access.html");

app.get("/", (_req, res) => res.redirect("/token"));
app.get("/token", (_req, res) => res.sendFile(tokenWorkspace));
app.get("/code", (_req, res) => res.sendFile(codeWorkspace));
app.get("/admin", (req, res) => { if (!isAdminAuthenticated(req)) return res.sendFile(adminAccessWorkspace); return res.sendFile(adminWorkspace); });
app.get("/auth", (_req, res) => res.redirect("/"));
app.get("/settings", (_req, res) => res.redirect("/token"));
app.get("/connect", (_req, res) => res.redirect("/token"));
app.get("/dashboard", (_req, res) => res.redirect("/token"));
app.get("/bot-dashboard", (_req, res) => res.redirect("/token"));
app.get("/login", (_req, res) => res.redirect("/token"));
app.get("/servers", (_req, res) => res.redirect("/token"));
app.get("/pair", (_req, res) => res.redirect("/code"));
app.get("/health", (req, res) => res.send("🤖 Firebox Bot SaaS is Online!"));

app.listen(PORT, () => {
    console.log(`🌍 Redtech Ai SaaS listening on port ${PORT}`);
    fireboxWebhook.start();
    botManager.restorePersisted().catch((error) => console.error("❌ Persistent bot restore failed:", error.message));
});
