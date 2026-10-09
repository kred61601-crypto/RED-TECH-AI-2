module.exports = {
    name: "delete",
    aliases: ["del"],
    description: "Delete the replied message.",
    category: "admin",
    adminOnly: true,
    groupOnly: true,
    async execute({ sock, jid, msg }) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || msg.message?.documentMessage?.contextInfo;
        const quoted = contextInfo?.quotedMessage;
        const botJid = sock.user?.id ? `${sock.user.id.split(":")[0]}@s.whatsapp.net` : sock.myJid;
        const key = {
            remoteJid: jid,
            fromMe: contextInfo?.participant === botJid,
            id: contextInfo?.stanzaId,
            participant: contextInfo?.participant,
        };

        if (!key.id) return await sock.sendMessage(jid, { text: "❓ *Usage:* Reply to a message with `.delete` to remove it." });

        try {
            await sock.sendMessage(jid, { delete: key });
        } catch (err) {
            console.error("Delete command error:", err);
            await sock.sendMessage(jid, { text: "❌ Failed to delete message. Ensure I am admin." });
        }
    }
};
