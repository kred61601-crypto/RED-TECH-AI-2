const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { initDb, isOnline } = require("../redtech/db");

const storePath = path.join(__dirname, "..", "database", "redtech_tokens.json");
const encryptionKey = crypto.createHash("sha256").update(String(process.env.REDTECH_TOKEN_SECRET || process.env.SESSION_SECRET || "redtech-development-secret")).digest();
const tokenPattern = /^REDTECH-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const tokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenCiphertext: { type: mongoose.Schema.Types.Mixed, required: true },
    phone: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, default: "active", index: true },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: Date,
    expiresAt: Date,
    pairingAttempts: { type: Number, default: 0 },
}, { collection: "redtech_tokens" });
let FireboxToken;
try { FireboxToken = mongoose.model("RedtechToken"); } catch { FireboxToken = mongoose.model("RedtechToken", tokenSchema); }

function readRecords() {
    try { return JSON.parse(fs.readFileSync(storePath, "utf8")); } catch { return []; }
}
function writeRecords(records) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temp = `${storePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(records, null, 2));
    fs.renameSync(temp, storePath);
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function encryptText(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64url"), data: encrypted.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}
function decryptText(payload) {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(payload.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64url")), decipher.final()]).toString("utf8");
}
function decryptPhone(record) { return decryptText(record.phone); }
function makeToken() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
    return `REDTECH-${part()}-${part()}`;
}
function normalizePhone(phone) {
    const clean = String(phone || "").replace(/\D/g, "");
    if (clean.length < 7 || clean.length > 15) throw new Error("Invalid phone number. Include country code.");
    return clean;
}
async function useMongo() {
    await initDb();
    return isOnline();
}
function plain(record) {
    const item = record.toObject ? record.toObject() : record;
    return {
        token: item.tokenCiphertext ? decryptText(item.tokenCiphertext) : null,
        phone: decryptPhone(item),
        status: item.status,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        expiresAt: item.expiresAt,
        pairingAttempts: Number(item.pairingAttempts || 0),
    };
}

module.exports = {
    async create(phone) {
        const normalized = normalizePhone(phone);
        const token = makeToken();
        const record = {
            tokenHash: hashToken(token),
            tokenCiphertext: encryptText(token),
            phone: encryptText(normalized),
            status: "active",
            createdAt: new Date(),
            lastUsedAt: null,
            expiresAt: null,
            pairingAttempts: 0,
        };
        if (await useMongo()) {
            const existing = await FireboxToken.find({ status: "active" }).lean();
            if (existing.some(item => { try { return decryptPhone(item) === normalized; } catch (_) { return false; } })) {
                throw new Error("This phone number already has a Redtech token. Use the existing token instead.");
            }
            await FireboxToken.create(record);
        } else {
            const records = readRecords();
            if (records.some(item => { try { return decryptPhone(item) === normalized; } catch (_) { return false; } })) {
                throw new Error("This phone number already has a Redtech token. Use the existing token instead.");
            }
            record.createdAt = record.createdAt.toISOString();
            writeRecords([...records, record]);
        }
        return token;
    },
    async resolve(token) {
        const normalized = String(token || "").trim().toUpperCase();
        if (!tokenPattern.test(normalized)) throw new Error("Invalid Redtech token format.");
        const hash = hashToken(normalized);
        let record;
        let records;
        if (await useMongo()) {
            record = await FireboxToken.findOne({ tokenHash: hash }).lean();
        } else {
            records = readRecords();
            record = records.find(item => item.tokenHash === hash);
        }
        if (!record || record.status !== "active") throw new Error(" token not found or inactive.");
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) throw new Error("Redtech token has expired.");
        return { token: normalized, phone: decryptPhone(record), record, records, mongo: await useMongo() };
    },
    async markUsed(resolved) {
        if (resolved.mongo) {
            await FireboxToken.updateOne({ tokenHash: resolved.record.tokenHash }, { $set: { lastUsedAt: new Date() }, $inc: { pairingAttempts: 1 } });
            return;
        }
        resolved.record.lastUsedAt = new Date().toISOString();
        resolved.record.pairingAttempts = Number(resolved.record.pairingAttempts || 0) + 1;
        writeRecords(resolved.records);
    },
    async listAdmin() {
        if (await useMongo()) return (await FireboxToken.find({}).lean()).map(plain);
        return readRecords().map(plain);
    },
    async listActiveBotIds() {
        if (await useMongo()) {
            return (await RedtechToken.find({ status: "active" }).select({ tokenHash: 1 }).lean()).map(item => item.tokenHash);
        }
        return readRecords().filter(item => item.status === "active").map(item => item.tokenHash);
    },
};
        
