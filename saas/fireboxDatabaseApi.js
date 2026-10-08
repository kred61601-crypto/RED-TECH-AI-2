const crypto = require("crypto");
const express = require("express");
const { mongoose, isOnline } = require("../firebox/db");
const jsonStore = require("../firebox/jsonStore");
const tokenRegistry = require("./tokenRegistry");

const API_VERSION = "1.0";
const STORE_KEY = "firebox_database_api_key";
const PASSWORD_KEY = /^(password|passwd|pwd|passcode|passwordhash|password_hash|hashedpassword|hashed_password)$/i;
const INFRASTRUCTURE_SECRET_KEY = /(connection(uri|string)?|database[_-]?url|encryption[_-]?key|master[_-]?key|credential|cookie|session|authorization)/i;
const RESERVED_COLLECTIONS = new Set(["system.users", "system.version", "firebox_database_api_keys"]);

const keySchema = new mongoose.Schema({
    hash: { type: String, required: true, unique: true },
    prefix: { type: String, required: true, default: "fbx_db_" },
    createdAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
}, { collection: "firebox_database_api_keys", versionKey: false });
let KeyModel;
try { KeyModel = mongoose.model("FireboxDatabaseApiKey"); }
catch { KeyModel = mongoose.model("FireboxDatabaseApiKey", keySchema); }

function hashKey(key) {
    return crypto.createHash("sha256").update(String(key), "utf8").digest("hex");
}
function generateKey() {
    return `fbx_db_${crypto.randomBytes(32).toString("base64url")}`;
}
function cleanValue(value, depth = 0) {
    if (depth > 8) return "[Truncated]";
    if (Array.isArray(value)) return value.slice(0, 100).map(item => cleanValue(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (PASSWORD_KEY.test(key) || INFRASTRUCTURE_SECRET_KEY.test(key)) continue;
        if (key === "_id" && item && typeof item === "object" && item.toString) output[key] = item.toString();
        else output[key] = cleanValue(item, depth + 1);
    }
    return output;
}
function jsonRecordEntries() {
    const data = jsonStore._global.getAll();
    return Object.entries(data)
        .filter(([key]) => key !== STORE_KEY && !PASSWORD_KEY.test(key) && !INFRASTRUCTURE_SECRET_KEY.test(key))
        .map(([key, value]) => {
            const cleaned = cleanValue(value);
            return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
                ? { id: key, ...cleaned }
                : { id: key, value: cleaned };
        });
}
function jsonCollections() {
    const records = jsonRecordEntries();
    return records.length ? [{ name: "json_store", type: "collection", source: "json-fallback", count: records.length }] : [];
}
function parseLimit(value, fallback = 50) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(Math.max(number, 1), 100) : fallback;
}
function parseOffset(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.max(number, 0) : 0;
}
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeCollectionName(name) {
    return typeof name === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(name) && !name.startsWith("system.") && !RESERVED_COLLECTIONS.has(name);
}
async function activeKeyRecord() {
    if (isOnline() && mongoose.connection.db) return KeyModel.findOne({ revokedAt: null }).lean();
    return jsonStore._global.get(STORE_KEY, null);
}
async function persistKey(record) {
    if (isOnline() && mongoose.connection.db) {
        await KeyModel.updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } });
        return KeyModel.create(record);
    }
    jsonStore._global.set(STORE_KEY, record);
    return record;
}
async function revokeKey() {
    if (isOnline() && mongoose.connection.db) return KeyModel.updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } });
    const existing = jsonStore._global.get(STORE_KEY, null);
    if (existing) jsonStore._global.set(STORE_KEY, { ...existing, revokedAt: new Date().toISOString() });
    return existing;
}
async function issueKey() {
    const plaintext = generateKey();
    const record = { hash: hashKey(plaintext), prefix: "fbx_db_", createdAt: new Date(), revokedAt: null };
    await persistKey(record);
    return { plaintext, record };
}
async function authenticateDatabaseKey(req, res, next) {
    const header = String(req.get("authorization") || "");
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: "Authorization Bearer token required." });
    const supplied = match[1].trim();
    const active = await activeKeyRecord();
    const suppliedHash = Buffer.from(hashKey(supplied));
    const activeHash = Buffer.from(String(active?.hash || ""));
    if (!active || suppliedHash.length !== activeHash.length || !crypto.timingSafeEqual(suppliedHash, activeHash)) {
        return res.status(401).json({ error: "Invalid or revoked API key." });
    }
    next();
}
async function collectionNames() {
    if (isOnline() && mongoose.connection.db) {
        const names = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
        return names.map(item => item.name).filter(safeCollectionName);
    }
    return jsonCollections().map(item => item.name);
}
function metadata() {
    return {
        appName: process.env.APP_NAME || "Firebox Bot",
        apiVersion: API_VERSION,
        databaseType: isOnline() ? "mongodb" : "json-fallback",
        capabilities: { read: true, create: false, update: false, delete: false, schemaChanges: false, arbitraryCommands: false },
    };
}
async function readCollection(name, query) {
    const limit = parseLimit(query.limit);
    const skip = parseOffset(query.offset);
    const search = String(query.search || "").trim().toLowerCase();
    if (name === "json_store") {
        let records = jsonRecordEntries();
        if (search) records = records.filter(item => JSON.stringify(item).toLowerCase().includes(search));
        return { records: records.slice(skip, skip + limit), total: records.length, limit, offset: skip };
    }
    if (!safeCollectionName(name)) throw Object.assign(new Error("Collection is not available."), { status: 404 });
    const collection = mongoose.connection.db.collection(name);
    const filter = {};
    if (query.filter) {
        try {
            const parsed = JSON.parse(query.filter);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
            for (const [key, value] of Object.entries(parsed)) if (/^[A-Za-z0-9_.-]{1,80}$/.test(key) && !PASSWORD_KEY.test(key) && !INFRASTRUCTURE_SECRET_KEY.test(key)) filter[key] = typeof value === "string" ? value.slice(0, 500) : value;
        } catch { throw Object.assign(new Error("filter must be a valid JSON object."), { status: 400 }); }
    }
    if (search) filter.$or = [{ _id: { $regex: escapeRegex(search), $options: "i" } }];
    const [records, total] = await Promise.all([
        collection.find(filter, { projection: { password: 0, passwd: 0, pwd: 0, passcode: 0, passwordHash: 0, password_hash: 0, hashedPassword: 0, hashed_password: 0, connectionString: 0, connectionUri: 0, databaseUrl: 0, encryptionKey: 0, masterKey: 0, credentials: 0, cookie: 0, session: 0, authorization: 0 } }).skip(skip).limit(limit).toArray(),
        collection.countDocuments(filter),
    ]);
    return { records: records.map(cleanValue), total, limit, offset: skip };
}
async function readRecord(name, id) {
    if (name === "json_store") {
        const record = jsonRecordEntries().find(item => String(item.id) === String(id));
        if (!record) throw Object.assign(new Error("Record not found."), { status: 404 });
        return record;
    }
    if (!safeCollectionName(name)) throw Object.assign(new Error("Collection is not available."), { status: 404 });
    const collection = mongoose.connection.db.collection(name);
    const candidates = [{ _id: id }];
    if (mongoose.isValidObjectId(id)) candidates.unshift({ _id: new mongoose.Types.ObjectId(id) });
    const projection = { password: 0, passwd: 0, pwd: 0, passcode: 0, passwordHash: 0, password_hash: 0, hashedPassword: 0, hashed_password: 0, connectionString: 0, connectionUri: 0, databaseUrl: 0, encryptionKey: 0, masterKey: 0, credentials: 0, cookie: 0, session: 0, authorization: 0 };
    const record = await collection.findOne({ $or: candidates }, { projection });
    if (!record) throw Object.assign(new Error("Record not found."), { status: 404 });
    return cleanValue(record);
}
function sendApiError(res, error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    return res.status(status).json({ error: error?.message || "Unable to read database." });
}
function createDatabaseApiRouter() {
    const router = express.Router();
    router.use(authenticateDatabaseKey);
    router.get("/info", (_req, res) => res.json({ ...metadata(), resources: ["control-room/tokens"], fields: ["phone", "token", "status", "createdAt", "lastUsedAt", "expiresAt", "pairingAttempts"] }));
    router.get("/collections", async (_req, res) => {
        try {
            const names = await collectionNames();
            const collections = await Promise.all(names.map(async name => {
                if (name === "json_store") return jsonCollections()[0];
                const count = await mongoose.connection.db.collection(name).countDocuments();
                return { name, type: "collection", source: "mongodb", count };
            }));
            res.json({ collections });
        } catch (error) { sendApiError(res, error); }
    });
    router.get("/collections/:collection/records", async (req, res) => {
        try { res.json(await readCollection(req.params.collection, req.query)); }
        catch (error) { sendApiError(res, error); }
    });
    router.get("/collections/:collection/records/:id", async (req, res) => {
        try { res.json(await readRecord(req.params.collection, req.params.id)); }
        catch (error) { sendApiError(res, error); }
    });
    router.get("/control-room/tokens", async (req, res) => {
        try {
            const all = await tokenRegistry.listAdmin();
            const search = String(req.query.search || "").trim().toLowerCase();
            const status = String(req.query.status || "").trim().toLowerCase();
            const filtered = all.filter(item => (!status || String(item.status).toLowerCase() === status) && (!search || String(item.phone).includes(search) || String(item.token).toLowerCase().includes(search)));
            const limit = parseLimit(req.query.limit);
            const offset = parseOffset(req.query.offset);
            res.json({ records: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
        } catch (error) {
            res.status(503).json({ error: "Unable to read Firebox token registry." });
        }
    });
    router.get("/control-room/tokens/count", async (_req, res) => {
        try { res.json({ count: (await tokenRegistry.listAdmin()).length }); }
        catch { res.status(503).json({ error: "Unable to read Firebox token registry." }); }
    });
    return router;
}
function createAdminRouter(requireAdmin) {
    const router = express.Router();
    router.use(express.json(), requireAdmin);
    router.get("/status", async (_req, res) => {
        const record = await activeKeyRecord();
        res.json({ configured: Boolean(record && !record.revokedAt), prefix: "fbx_db_", createdAt: record?.createdAt || null, permissions: { read: true, create: false, update: false, delete: false } });
    });
    router.post("/generate", async (_req, res) => { const result = await issueKey(); res.status(201).json({ apiKey: result.plaintext, createdAt: result.record.createdAt, warning: "Store this key securely. It will not be shown again." }); });
    router.post("/regenerate", async (_req, res) => { const result = await issueKey(); res.status(201).json({ apiKey: result.plaintext, createdAt: result.record.createdAt, warning: "The previous key was revoked. Store this key securely." }); });
    router.post("/revoke", async (_req, res) => { await revokeKey(); res.json({ success: true, configured: false }); });
    return router;
}
module.exports = { API_VERSION, hashKey, generateKey, cleanValue, authenticateDatabaseKey, createDatabaseApiRouter, createAdminRouter, _test: { jsonRecordEntries, safeCollectionName, metadata, readCollection, readRecord } };


            
