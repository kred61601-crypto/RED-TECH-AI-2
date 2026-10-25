
"use strict";

const express = require("express");
const crypto = require("crypto");
const botManager = require("./botManager");

const router = express.Router();

// In-memory limits. These reset when the server restarts.
// Use a shared Redis/database store if you run multiple instances.
const ipRequests = new Map();
const phoneRequests = new Map();
const activeRequests = new Set();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 5;
const MAX_REQUESTS_PER_PHONE = 3;
const MAX_ACTIVE_REQUESTS = 10;

function cleanExpired(map) {
  const now = Date.now();

  for (const [key, entry] of map.entries()) {
    if (entry.resetAt <= now) map.delete(key);
  }
}

function checkLimit(map, key, max) {
  const now = Date.now();
  let entry = map.get(key);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    map.set(key, entry);
  }

  if (entry.count >= max) {
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000)
      )
    };
  }

  entry.count++;

  return { allowed: true };
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function publicUserId(phone) {
  // The number itself is not used as a session folder name.
  return "public_" + crypto
    .createHash("sha256")
    .update(phone)
    .digest("hex");
}

// Do not trust arbitrary X-Forwarded-For values here.
// Configure Express trust proxy for your actual hosting setup.
router.use((req, res, next) => {
  cleanExpired(ipRequests);
  cleanExpired(phoneRequests);

  const ip = String(req.ip || req.socket.remoteAddress || "unknown");

  const result = checkLimit(ipRequests, ip, MAX_REQUESTS_PER_IP);

  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfter));

    return res.status(429).json({
      ok: false,
      error: "Too many pairing requests. Please try again later."
    });
  }

  next();
});

router.post("/pair-code", async (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);

  if (!/^[1-9]\d{7,14}$/.test(phone)) {
    return res.status(400).json({
      ok: false,
      error: "Enter a valid international WhatsApp number with country code."
    });
  }

  const phoneKey = crypto
    .createHash("sha256")
    .update(phone)
    .digest("hex");

  const phoneLimit = checkLimit(
    phoneRequests,
    phoneKey,
    MAX_REQUESTS_PER_PHONE
  );

  if (!phoneLimit.allowed) {
    res.set("Retry-After", String(phoneLimit.retryAfter));

    return res.status(429).json({
      ok: false,
      error: "Too many requests for this number. Please try again later."
    });
  }

  if (activeRequests.has(phoneKey)) {
    return res.status(409).json({
      ok: false,
      error: "A pairing request for this number is already in progress."
    });
  }

  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
    return res.status(503).json({
      ok: false,
      error: "The pairing service is busy. Please try again shortly."
    });
  }

  activeRequests.add(phoneKey);

  try {
    const userId = publicUserId(phone);
    const inst = botManager.get(userId);

    if (inst.status === "online") {
      return res.status(409).json({
        ok: false,
        error: "This WhatsApp session is already connected."
      });
    }

    // Start the instance if it is offline.
    if (inst.status === "offline" && !inst.isReconnecting) {
      await inst.start();
    }

    const rawCode = await inst.triggerPairingRestart(phone);
    const code = String(rawCode || "")
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase();

    if (!/^[A-Z0-9]{8}$/.test(code)) {
      throw new Error("WhatsApp did not return a valid pairing code.");
    }

    return res.json({
      ok: true,
      code
    });
  } catch (error) {
    console.error("Public pairing failed:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Pairing failed. Please wait and try again."
    });
  } finally {
    activeRequests.delete(phoneKey);
  }
});

module.exports = router;
