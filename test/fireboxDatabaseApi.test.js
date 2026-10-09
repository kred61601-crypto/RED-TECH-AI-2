const assert = require("node:assert/strict");
const test = require("node:test");
const { generateKey, hashKey, cleanValue, _test } = require("../saas/fireboxDatabaseApi");

test("database API keys use a secure firebox prefix and are unique", () => {
    const first = generateKey();
    const second = generateKey();
    assert.match(first, /^fbx_db_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    assert.equal(hashKey(first).length, 64);
    assert.notEqual(hashKey(first), first);
});

test("record redaction keeps user tokens and API keys but removes passwords", () => {
    const result = cleanValue({ id: "u1", password: "hidden", profile: { apiKey: "user-key", name: "Ada" }, items: [{ token: "user-token", value: 2 }] });
    assert.deepEqual(result, { id: "u1", profile: { apiKey: "user-key", name: "Ada" }, items: [{ token: "user-token", value: 2 }] });
});

test("collection validation rejects system and unsafe names", () => {
    assert.equal(_test.safeCollectionName("users"), true);
    assert.equal(_test.safeCollectionName("system.users"), false);
    assert.equal(_test.safeCollectionName("users;drop"), false);
    assert.equal(_test.safeCollectionName("../secrets"), false);
});

test("metadata exposes read capability without secrets", () => {
    const info = _test.metadata();
    assert.equal(info.capabilities.read, true);
    assert.equal(info.capabilities.create, false);
    assert.equal(info.capabilities.update, false);
    assert.equal(info.capabilities.delete, false);
    assert.equal("connectionString" in info, false);
});
