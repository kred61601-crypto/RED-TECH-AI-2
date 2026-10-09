const { ownerNumbers } = require("../../config");

module.exports = {
    name: "owner",
    aliases: ["creator", "master", "boss"],
    description: "Displays the Bot Owner's contact information.",
    category: "general",

    async execute({ sock, jid, msg }) {
        try {
            // 👑 React immediately when the command is used
            if (msg?.key) {
                await sock.sendMessage(jid, {
                    react: {
                        text: "👑",
                        key: msg.key
                    }
                }).catch(() => {});
            }

            // Get the primary owner number safely
            const rawOwner = Array.isArray(ownerNumbers)
                ? ownerNumbers[0]
                : "";

            const primaryOwner = String(rawOwner || "")
                .replace(/@s\.whatsapp\.net$/, "")
                .replace(/:\d+$/, "")
                .replace(/\D/g, "");

            if (!primaryOwner) {
                await sock.sendMessage(jid, {
                    text: "❌ Owner number is not configured. Please check config.js."
                }, { quoted: msg });

                return;
            }

            // 👑 Owner contact card
            const vcard =
                "BEGIN:VCARD\n" +
                "VERSION:3.0\n" +
                "FN:Denzel\n" +
                "ORG:Redtech Studios;\n" +
                `TEL;type=CELL;type=VOICE;waid=${primaryOwner}:+${primaryOwner}\n` +
                "END:VCARD";

            await sock.sendMessage(jid, {
                contacts: {
                    displayName: "Denzel",
                    contacts: [{ vcard }]
                }
            }, { quoted: msg });

            // 📱 Owner details
            await sock.sendMessage(jid, {
                text:
                    `🧑‍💻 *𝐑𝐄𝐃𝐓𝐄𝐂𝐇 𝐀𝐈 OWNER*\n\n` +
                    `👤 *Owner:* Denzel\n` +
                    `🏢 *Company:* Redtech Studios\n` +
                    `📱 *WhatsApp:* +${primaryOwner}\n` +
                    `💻 *GitHub:* https://github.com/kred61601-crypto/RED-TECH-AI-2.git-bot`
            }, { quoted: msg });

            // ✅ React when finished
            if (msg?.key) {
                await sock.sendMessage(jid, {
                    react: {
                        text: "✅",
                        key: msg.key
                    }
                }).catch(() => {});
            }

        } catch (err) {
            console.error("Owner card error:", err);

            await sock.sendMessage(jid, {
                text: "❌ Failed to send owner contact information."
            }, { quoted: msg }).catch(() => {});
        }
    }
};
