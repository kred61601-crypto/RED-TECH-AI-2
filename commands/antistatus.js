const { getSettings } = require("../../lib/settings");
const jsonStore = require("../../redtech/jsonStore");

module.exports = {
    name: "antistatus",
    aliases: ["antistatusmention"],
    description: "Configure group anti-status-mention protection",
    category: "group",

    async execute({ sock, jid, sender, args = [], msg }) {
        const reply = async (text) => sock.sendMessage(
            jid,
            { text },
            { quoted: msg }
        );

        // ⚡ React immediately when this command executes.
        if (msg?.key && !msg.key.fromMe) {
            await sock.sendMessage(jid, {
                react: {
                    text: "⚡",
                    key: msg.key
                }
            }).catch(() => {});
        }

        if (!jid || !jid.endsWith("@g.us")) {
            return reply(
                "❌ This command can only be used inside a WhatsApp group."
            );
        }

        const mode = String(args[0] || "").toLowerCase();

        if (!["on", "off", "delete", "warn"].includes(mode)) {
            return reply(
                "🛡️ *REDTECH-AI ULTRA — ANTI STATUS MENTION*\n\n" +
                "⚡ .antistatus on\n" +
                "⚡ .antistatus off\n" +
                "⚡ .antistatus delete\n" +
                "⚡ .antistatus warn"
            );
        }

        const metadata = await sock.groupMetadata(jid).catch(() => null);

        if (!metadata) {
            return reply("❌ Could not load group information. Try again.");
        }

        const senderJid = String(sender || msg?.key?.participant || "")
            .replace(/:\d+@/, "@");

        const participant = metadata.participants.find(p =>
            p.id === senderJid ||
            p.jid === senderJid ||
            String(p.id || "").split(":")[0] === senderJid.split(":")[0]
        );

        const settings = getSettings();

        const senderNumber = senderJid.split("@")[0].replace(/\D/g, "");
        const sudoNumber = String(process.env.SUDO || "").replace(/\D/g, "");
        const ownerNumber = String(settings.ownerNumber || "")
            .replace(/\D/g, "");

        const isOwner =
            Boolean(msg?.key?.fromMe) ||
            (sudoNumber && senderNumber === sudoNumber) ||
            (ownerNumber && senderNumber === ownerNumber);

        const isAdmin = Boolean(
            participant?.admin || participant?.isSuperAdmin
        );

        if (!isOwner && !isAdmin) {
            return reply(
                "⛔ Only group admins or the bot owner can change this setting."
            );
        }

        // "on" enables warning mode without automatically kicking members.
        const selectedMode = mode === "on" ? "warn" : mode;

        jsonStore.set(`antistatusmention_mode_${jid}`, selectedMode);

        const descriptions = {
            on: "Protection enabled with warning mode.",
            off: "Protection disabled for this group.",
            delete: "Protection enabled with delete mode.",
            warn: "Protection enabled with warning mode."
        };

        return reply(
            `✅ *REDTECH-AI ULTRA*\n\n` +
            `⚡ Anti-status mention: *${mode.toUpperCase()}*\n` +
            `${descriptions[mode]}`
        );
    }
};
          
