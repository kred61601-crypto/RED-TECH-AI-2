const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "../database/active.json");

// Ensure file exists
if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({}, null, 2));
}

function getActiveDB() {
    try {
        return JSON.parse(fs.readFileSync(dbPath));
    } catch {
        return {};
    }
}

function saveActiveDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function trackMessage(groupId, userId) {
    const db = getActiveDB();
    if (!db[groupId]) db[groupId] = {};

    db[groupId][userId] = Date.now(); // Save last active time
    saveActiveDB(db);
}

function getGroupActivity(groupId) {
    const db = getActiveDB();
    return db[groupId] || {};
}

module.exports = { trackMessage, getGroupActivity, getActiveDB };
