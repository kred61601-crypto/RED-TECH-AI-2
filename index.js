
"use strict";

/**
 * KING RED AI SaaS
 * Multi-user WhatsApp bot server for Render.
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const redtechWebhook = require("./saas/redtechWebhook");
const botManager = require("./saas/botManager");
const {
    isAdminAuthenticated,
    requireAdmin
} = require("./saas/adminAuth");

const app = express();
const PORT = Number(process.env.PORT) || 10000;

// Reduce unnecessary Baileys Signal log noise.
const originalError = console.error.bind(console);
const originalLog = console.log.bind(console);

const signalMessages = [
    ["Bad MAC", "Signal key refresh requested."],
    ["No matching sessions found", "Waiting for Signal key exchange."],
    ["No session found to decrypt", "Waiting for sender session."],
    ["Failed to decrypt message with any known session", "Message could not be decrypted."],
    ["Closing open session in favor of incoming prekey", "Refreshing Signal session."]
];

function filterSignalLog(original, args) {
    const first = String(args[0] ?? "");

    for (const [match, replacement] of signalMessages) {
        if (first.includes(match)) {
            original(`[KING RED AI] ${replacement}`);
            return;
        }
    }

    original(...args);
}

console.error = (...args) => filterSignalLog(originalError, args);
console.log = (...args) => filterSignalLog(originalLog, args);

process.on("unhandledRejection", reason => {
    originalError("[KING RED AI] Unhandled rejection:", reason);
});

process.on("uncaughtException", error => {
    originalError("[KING RED AI] Uncaught exception:", error);
});

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const sessionSecret = process.env.SESSION_SECRET;

if (process.env.NODE_ENV === "production" && !sessionSecret) {
    throw new Error(
        "Missing SESSION_SECRET. Add it in Render Environment."
    );
}

app.use(session({
    name: "kingred.sid",
    secret: sessionSecret || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));

// Public dashboard assets.
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir, { index: false }));

// SaaS APIs. Keep the existing route modules.
app.use("/api/auth", require("./saas/authApiRoutes"));
app.use("/api/admin", require("./saas/adminApiRoutes"));
app.use("/api/bot", require("./saas/userApiRoutes"));

const databaseApi = require("./saas/redtechDatabaseApi");

app.use(
    "/api/redtech-database/v1",
    databaseApi.createDatabaseApiRouter()
);

app.use(
    "/api/redtech/database",
    databaseApi.createDatabaseApiRouter()
);

app.use(
    "/api/admin/redtech-database",
    databaseApi.createAdminRouter(requireAdmin)
);

// Dashboard pages.
app.get("/", (_req, res) => res.redirect("/token"));

app.get("/token", (_req, res) => {
    res.sendFile(path.join(publicDir, "token.html"));
});

app.get("/code", (_req, res) => {
    res.sendFile(path.join(publicDir, "code.html"));
});

app.get("/admin", (req, res) => {
    const file = isAdminAuthenticated(req)
        ? "admin.html"
        : "admin-access.html";

    res.sendFile(path.join(publicDir, file));
});

app.get("/auth", (_req, res) => res.redirect("/token"));
app.get("/settings", (_req, res) => res.redirect("/token"));
app.get("/connect", (_req, res) => res.redirect("/token"));
app.get("/dashboard", (_req, res) => res.redirect("/token"));
app.get("/bot-dashboard", (_req, res) => res.redirect("/token"));
app.get("/login", (_req, res) => res.redirect("/token"));
app.get("/servers", (_req, res) => res.redirect("/token"));
app.get("/pair", (_req, res) => res.redirect("/code"));

// Health check for Render.
app.get("/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        name: "KING RED AI SaaS",
        status: "online",
        timestamp: new Date().toISOString()
    });
});

// Unknown API endpoint.
app.use("/api", (_req, res) => {
    res.status(404).json({
        error: "API endpoint not found."
    });
});

// Central error handler.
app.use((err, _req, res, _next) => {
    originalError("[KING RED AI] Request error:", err);

    if (res.headersSent) return;

    res.status(err.status || 500).json({
        error: "An internal server error occurred."
    });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    originalLog(
        `KING RED AI SaaS listening on port ${PORT}`
    );

    // A webhook failure should not hide the real server startup.
    try {
        if (
            redtechWebhook &&
            typeof redtechWebhook.start === "function"
        ) {
            redtechWebhook.start();
        }
    } catch (error) {
        originalError(
            "[KING RED AI] Webhook startup failed:",
            error.message
        );
    }

    if (
        botManager &&
        typeof botManager.restorePersisted === "function"
    ) {
        botManager.restorePersisted().catch(error => {
            originalError(
                "[KING RED AI] Bot restore failed:",
                error.message
            );
        });
    }
});

function shutdown(signal) {
    originalLog(`[KING RED AI] ${signal} received.`);

    server.close(() => {
        for (const bot of botManager.all()) {
            botManager.stop(bot.userId);
        }

        process.exit(0);
    });

    const forceExit = setTimeout(() => {
        process.exit(1);
    }, 10000);

    forceExit.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, server };
