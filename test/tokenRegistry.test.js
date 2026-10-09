const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const registry = require("../saas/tokenRegistry");

const storePath = path.join(__dirname, "../database/redtech_tokens.json");

test("token registry creates opaque tokens and resolves the protected phone internally", async () => {
    try { fs.unlinkSync(storePath); } catch {}
    const token = await registry.create("+254 100 969 922");
    assert.match(token, /^REDTECH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const resolved = await registry.resolve(token);
    assert.equal(resolved.phone, "254100969922");
    assert.equal(resolved.record.status, "active");
    assert.equal(resolved.record.pairingAttempts, 0);
    assert.ok(!JSON.stringify({ token }).includes(resolved.phone));
    await registry.markUsed(resolved);
    assert.equal((await registry.resolve(token)).record.pairingAttempts, 1);
    const adminRecords = await registry.listAdmin();
    assert.equal(adminRecords[0].token, token);
    assert.equal(adminRecords[0].phone, "254100969922");
    await assert.rejects(
        () => registry.create("254100969922"),
        /already has a Redtech token/
    );
});

test.after(() => { try { fs.unlinkSync(storePath); } catch {} });
