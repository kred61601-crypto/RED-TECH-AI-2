
/**
 * KING RED AI SaaS — Render entry point
 * Multi-user WhatsApp bot dashboard and API server.
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

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const sessionSecret = process.env.SESSION_SECRET;

if (process.env.NODE_ENV === "production" && !sessionSecret) {
    throw new Error(
        "SESSION_SECRET must be set in Render environment variables."
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

// Static dashboard assets.
app.use(express.static(path.join(__dirname, "public"), {
    index: false
}));

// SaaS authentication and bot APIs.
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
const publicDir = path.join(__dirname, "public");

app.get("/", (_req, res) => res.redirect("/token"));

app.get("/token", (_req, res) =>
    res.sendFile(path.join(publicDir, "token.html"))
);

app.get("/code", (_req, res) =>
    res.sendFile(path.join(publicDir, "code.html"))
);

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

// Handle unknown API routes without crashing the server.
app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
});

// Express error handler.
app.use((err, _req, res, _next) => {
    console.error("[KING RED AI] Request error:", err.message);

    if (res.headersSent) return;

    res.status(err.status || 500).json({
        error: "An internal server error occurred."
    });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`KING RED AI SaaS listening on port ${PORT}`);

    // The webhook is optional. A missing webhook configuration
    // must not prevent Render from starting the web server.
    try {
        redtechWebhook.start();
    } catch (error) {
        console.error("Webhook startup failed:", error.message);
    }

    botManager.restorePersisted().catch(error => {
        console.error(
            "Bot restore failed:",
            error.message
        );
    });
});

function shutdown(signal) {
    console.log(`${signal} received; shutting down KING RED AI.`);

    server.close(() => {
        for (const bot of botManager.all()) {
            botManager.stop(bot.userId);
        }

        process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, server };
    
