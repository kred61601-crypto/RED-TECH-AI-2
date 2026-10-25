
/**
 * REDTECH AI — SaaS Server
 *
 * Preserves existing pages, API routes, database endpoints, sessions,
 * webhook startup, and persisted bot restoration.
 *
 * Public pairing endpoint:
 *   POST /api/public-pair/pair-code
 *   Body: { "phone": "2547XXXXXXXX" }
 *
 * Required production environment:
 *   SESSION_SECRET
 *   REDTECH_TOKEN_SECRET (recommended)
 */

"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const redtechWebhook = require("./saas/redtechWebhook");
const { isAdminAuthenticated, requireAdmin } =
    require("./saas/adminAuth");
const botManager = require("./saas/botManager");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// ── Logging filter ───────────────────────────────────────────────────────────

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
    { match: "ephemeralKeyPair", msg: null }
];

const logCooldowns = new Map();
const LOG_COOLDOWN_MS = 30_000;

function interceptLog(originalFn, args) {
    const raw = String(args[0] ?? "");

    for (const { match, msg } of CLEAN_SIGNAL_ERRORS) {
        if (raw.includes(match)) {
            if (msg === null) return;

            const now = Date.now();

            if (
                now - (logCooldowns.get(match) || 0) >=
                LOG_COOLDOWN_MS
            ) {
                logCooldowns.set(match, now);
                _origLog(msg);
            }

            return;
        }
    }

    originalFn(...args);
}

console.error = (...args) => interceptLog(_origError, args);
console.log = (...args) => interceptLog(_origLog, args);

process.on("unhandledRejection", reason => {
    _origError("⚠️ Unhandled Rejection:", reason);
});

process.on("uncaughtException", error => {
    _origError("⚠️ Uncaught Exception:", error);
});

// ── Proxy configuration ──────────────────────────────────────────────────────
//
// Render terminates HTTPS at its proxy. Trust one proxy hop in production.
// Do not set this to `true` without checking the actual proxy topology.

if (IS_PRODUCTION) {
    app.set("trust proxy", 1);
}

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// Allows the Vercel frontend to call the Render backend.
// Add any additional trusted custom frontend origins explicitly.

const allowedOrigins = new Set(
    [
        "https://veamuz-kingred-bot.vercel.app",
        process.env.FRONTEND_ORIGIN
    ].filter(Boolean)
);

app.use((req, res, next) => {
    const origin = req.get("Origin");

    if (origin && allowedOrigins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        );
        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With"
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
        if (origin && !allowedOrigins.has(origin)) {
            return res.sendStatus(403);
        }

        return res.sendStatus(204);
    }

    next();
});

// ── Request parsing ──────────────────────────────────────────────────────────

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "1mb"
}));

// ── Browser session ──────────────────────────────────────────────────────────
//
// Set SESSION_SECRET in Render environment variables.
// A stable secret is essential to keep sessions valid across restarts.

const sessionSecret = process.env.SESSION_SECRET;

if (IS_PRODUCTION && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error(
        "SESSION_SECRET must be configured in production and be at least 32 characters."
    );
}

app.use(session({
    name: "redtech.sid",
    secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));

// ── Static website ───────────────────────────────────────────────────────────

app.use(express.static(
    path.join(__dirname, "public"),
    { index: false }
));

// ── Existing APIs ────────────────────────────────────────────────────────────

app.use("/api/auth", require("./saas/authApiRoutes"));
app.use("/api/admin", require("./saas/adminApiRoutes"));
app.use("/api/bot", require("./saas/userApiRoutes"));

// ── Public pairing API ───────────────────────────────────────────────────────
//
// The browser sends only a phone number. The pairing route must internally
// reuse tokenRegistry/botManager identities and must never return an access
// token. The route itself is responsible for pairing rate limits.

app.use(
    "/api/public-pair",
    require("./saas/publicPairRoutes")
);

// ── Existing database APIs ───────────────────────────────────────────────────

const {
    createDatabaseApiRouter,
    createAdminRouter
} = require("./saas/redtechDatabaseApi");

app.use(
    "/api/redtech-database/v1",
    createDatabaseApiRouter()
);

app.use(
    "/api/redtech/database",
    createDatabaseApiRouter()
);

app.use(
    "/api/admin/redtech-database",
    createAdminRouter(requireAdmin)
);

// ── Pages and legacy redirects ───────────────────────────────────────────────

const publicDir = path.join(__dirname, "public");

const tokenWorkspace = path.join(publicDir, "token.html");
const codeWorkspace = path.join(publicDir, "code.html");
const adminWorkspace = path.join(publicDir, "admin.html");
const adminAccessWorkspace = path.join(publicDir, "admin-access.html");

app.get("/", (_req, res) => res.redirect("/token"));

app.get("/token", (_req, res) => {
    res.sendFile(tokenWorkspace);
});

app.get("/code", (_req, res) => {
    res.sendFile(codeWorkspace);
});

app.get("/admin", (req, res) => {
    if (!isAdminAuthenticated(req)) {
        return res.sendFile(adminAccessWorkspace);
    }

    return res.sendFile(adminWorkspace);
});

app.get("/auth", (_req, res) => res.redirect("/"));
app.get("/settings", (_req, res) => res.redirect("/token"));
app.get("/connect", (_req, res) => res.redirect("/token"));
app.get("/dashboard", (_req, res) => res.redirect("/token"));
app.get("/bot-dashboard", (_req, res) => res.redirect("/token"));
app.get("/login", (_req, res) => res.redirect("/token"));
app.get("/servers", (_req, res) => res.redirect("/token"));
app.get("/pair", (_req, res) => res.redirect("/code"));

// ── Health endpoint ──────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        service: "REDTECH AI SaaS",
        status: "online",
        timestamp: new Date().toISOString()
    });
});

// ── 404 and error handling ────────────────────────────────────────────────────

app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
        return res.status(404).json({
            ok: false,
            error: "API endpoint not found."
        });
    }

    return res.status(404).send("Page not found.");
});

app.use((error, req, res, next) => {
    _origError("REDTECH server error:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(error.status || 500).json({
        ok: false,
        error: IS_PRODUCTION
            ? "An internal server error occurred."
            : error.message
    });
});

// ── Start server and restore persisted bots ───────────────────────────────────

const server = app.listen(PORT, () => {
    _origLog(`🌍 REDTECH AI SaaS listening on port ${PORT}`);

    if (
        redtechWebhook &&
        typeof redtechWebhook.start === "function"
    ) {
        try {
            redtechWebhook.start();
        } catch (error) {
            _origError(
                "REDTECH webhook startup failed:",
                error.message
            );
        }
    } else {
        _origLog(
            "ℹ️ REDTECH webhook has no start() method; skipping webhook startup."
        );
    }

    botManager.restorePersisted().catch(error => {
        _origError(
            "❌ Persistent bot restore failed:",
            error.message
        );
    });
});

module.exports = { app, server };
    
