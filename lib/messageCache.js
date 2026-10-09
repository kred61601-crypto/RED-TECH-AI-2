
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "../database/message_cache.json");
const MAX_ENTRIES = 50;

let cache = {};
let dirty = false;
let saveTimer = null;

function load() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const data = JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
            cache = data && typeof data === "object" && !Array.isArray(data)
                ? data
                : {};
        }
    } catch (error) {
        console.error("[MessageCache] Load error:", error.message);
        cache = {};
    }
}

function scheduleSave() {
    if (saveTimer) return;

    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (!dirty) return;

        dirty = false;

        const data = JSON.stringify(cache);
        const dir = path.dirname(LOG_FILE);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFile(LOG_FILE, data, "utf-8", (error) => {
            if (error) {
                console.error("[MessageCache] Save error:", error.message);
                dirty = true;
            }
        });
    }, 8000);
}

function setLog(msgId, record) {
    if (!msgId || !record) return;

    cache[msgId] = record;
    dirty = true;

    const keys = Object.keys(cache);

    if (keys.length > MAX_ENTRIES) {
        keys.sort(
            (a, b) =>
                (cache[a]?.timestamp || 0) -
                (cache[b]?.timestamp || 0)
        );

        const excess = keys.length - MAX_ENTRIES;

        for (const key of keys.slice(0, excess)) {
            delete cache[key];
        }
    }

    scheduleSave();
}

function getLog(msgId) {
    return cache[msgId] || null;
}

function getAllLogs() {
    return Object.values(cache);
}

load();

module.exports = {
    setLog,
    getLog,
    getAllLogs
};
                               
