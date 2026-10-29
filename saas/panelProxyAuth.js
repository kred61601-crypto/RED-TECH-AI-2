const crypto = require("crypto");

function matchesSecret(provided, expected) {
    if (!provided || !expected) return false;
    const left = Buffer.from(String(provided));
    const right = Buffer.from(String(expected));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isPanelProxy(req) {
    return req.get("X-Redtech-Panel-Proxy") === "1" && matchesSecret(req.get("X-Redtech-Panel-Key"), process.env.REDTECH_BOT_KEY);
}

module.exports = { matchesSecret, isPanelProxy };
