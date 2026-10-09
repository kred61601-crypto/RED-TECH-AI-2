const assert = require("node:assert/strict");
const test = require("node:test");
const antiStatusMention = require("../commands/admin/antistatusmention");
const deleteCommand = require("../commands/admin/delete");

test("anti-group-status-mention command is registered as an alias", () => {
    assert.ok(antiStatusMention.aliases.includes("antigroupstatusmention"));
});

test("delete command deletes the quoted message key from supported message types", async () => {
    let deleted;
    const sock = {
        user: { id: "254700000000:1@s.whatsapp.net" },
        sendMessage: async (_jid, payload) => { deleted = payload.delete; },
    };
    const msg = {
        message: {
            imageMessage: {
                contextInfo: { stanzaId: "quoted-id", participant: "254711111111@s.whatsapp.net", quotedMessage: { conversation: "hello" } },
            },
        },
    };
    await deleteCommand.execute({ sock, jid: "120363@g.us", msg });
    assert.deepEqual(deleted, {
        remoteJid: "120363@g.us",
        fromMe: false,
        id: "quoted-id",
        participant: "254711111111@s.whatsapp.net",
    });
});
