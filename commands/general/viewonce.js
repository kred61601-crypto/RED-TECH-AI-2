const { downloadMediaMessage } = require("@whiskeysockets/baileys");

module.exports = {
    name: "viewonceopen",
    aliases: ["viewonce", "vv"],
    description: "Reveal a view-once image or video by replying to it.",
    category: "general",

    execute: async (ctx) => {
        const { sock, jid, msg } = ctx;
        const message = msg;

        // React immediately before processing the command.
        const react = async (emoji) => {
            try {
                if (message?.key) {
                    await sock.sendMessage(jid, {
                        react: {
                            text: emoji,
                            key: message.key
                        }
                    });
                }
            } catch (error) {
                console.error("[ViewOnce Reaction Error]", error.message);
            }
        };

        await react("📷");

        try {
            if (!message?.message) {
                await sock.sendMessage(
                    jid,
                    { text: "❌ I couldn't read your command message." },
                    { quoted: message }
                );
                await react("❌");
                return;
            }

            // Get the message being replied to.
            const contextInfo =
                message.message.extendedTextMessage?.contextInfo ||
                message.message.imageMessage?.contextInfo ||
                message.message.videoMessage?.contextInfo;

            const quoted = contextInfo?.quotedMessage;

            if (!quoted) {
                await sock.sendMessage(
                    jid,
                    {
                        text: "❌ Please reply directly to a view-once image or video with .vv"
                    },
                    { quoted: message }
                );
                await react("⚠️");
                return;
            }

            // Unwrap common WhatsApp message wrappers.
            function unwrapMessage(content) {
                let current = content;

                for (let i = 0; i < 8; i++) {
                    const wrapper =
                        current?.ephemeralMessage ||
                        current?.viewOnceMessage ||
                        current?.viewOnceMessageV2 ||
                        current?.viewOnceMessageV2Extension ||
                        current?.documentWithCaptionMessage;

                    if (!wrapper?.message) break;
                    current = wrapper.message;
                }

                return current;
            }

            const mediaContent = unwrapMessage(quoted);
            const imageMsg = mediaContent?.imageMessage;
            const videoMsg = mediaContent?.videoMessage;

            if (!imageMsg && !videoMsg) {
                await sock.sendMessage(
                    jid,
                    {
                        text: "❌ The replied message is not a supported view-once image or video."
                    },
                    { quoted: message }
                );
                await react("⚠️");
                return;
            }

            // Reconstruct the quoted message for Baileys.
            const quotedKey = {
                remoteJid: jid,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant
            };

            if (!quotedKey.id) {
                await sock.sendMessage(
                    jid,
                    {
                        text: "❌ I couldn't identify the original message. Try replying to it again."
                    },
                    { quoted: message }
                );
                await react("⚠️");
                return;
            }

            const downloadMessage = {
                key: quotedKey,
                message: quoted
            };

            const buffer = await downloadMediaMessage(
                downloadMessage,
                "buffer",
                {},
                { logger: sock.logger || console }
            );

            if (!buffer || !buffer.length) {
                throw new Error("The downloaded media was empty.");
            }

            if (imageMsg) {
                await sock.sendMessage(
                    jid,
                    {
                        image: buffer,
                        caption: imageMsg.caption || "👑 KING RED AI"
                    },
                    { quoted: message }
                );
            } else {
                await sock.sendMessage(
                    jid,
                    {
                        video: buffer,
                        caption: videoMsg.caption || "👑 KING RED AI"
                    },
                    { quoted: message }
                );
            }

            await react("✅");

        } catch (error) {
            console.error("[ViewOnce Command Error]", error);

            await react("❌");

            try {
                await sock.sendMessage(
                    jid,
                    {
                        text:
                            "❌ *KING RED AI — VIEW ONCE ERROR*\n\n" +
                            "I couldn't retrieve that media. It may have expired, " +
                            "or WhatsApp may not have supplied the required message keys.\n\n" +
                            `Error: ${error.message || "Unknown error"}`
                    },
                    { quoted: message }
                );
            } catch (sendError) {
                console.error("[ViewOnce Reply Error]", sendError.message);
            }
        }
    }
};
