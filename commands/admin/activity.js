
const { MessageLog } = require("../../redtech/messageModel");

module.exports = {
    name: "activity",
    aliases: ["active", "topmembers"],
    description: "Show the most active members in the group.",
    category: "admin",
    adminOnly: true,
    groupOnly: true,

    async execute({ sock, jid, msg }) {
        try {
            // Make sure the command is being used in a group.
            if (!jid || !jid.endsWith("@g.us")) {
                return await sock.sendMessage(jid, {
                    text: "❌ This command can only be used in a group."
                }, { quoted: msg });
            }

            if (!MessageLog || typeof MessageLog.aggregate !== "function") {
                throw new Error(
                    "MessageLog is not a Mongoose model. Check messageModel.js."
                );
            }

            // Count stored messages for each group participant.
            const stats = await MessageLog.aggregate([
                {
                    $match: {
                        remoteJid: jid,
                        participant: {
                            $exists: true,
                            $ne: null,
                            $ne: ""
                        }
                    }
                },
                {
                    $group: {
                        _id: "$participant",
                        msgCount: { $sum: 1 }
                    }
                },
                {
                    $sort: { msgCount: -1 }
                },
                {
                    $limit: 10
                }
            ]);

            if (!stats.length) {
                return await sock.sendMessage(jid, {
                    text:
                        "📈 *KING RED AI — GROUP ACTIVITY*\n\n" +
                        "No saved member activity was found for this group yet.\n\n" +
                        "Messages must be recorded in the database before they can appear here."
                }, { quoted: msg });
            }

            const mentions = [];
            const lines = stats.map((stat, index) => {
                const participant = stat._id;

                if (
                    typeof participant !== "string" ||
                    !participant.includes("@")
                ) {
                    return null;
                }

                mentions.push(participant);

                const medals = ["🥇", "🥈", "🥉"];
                const rank = medals[index] || `${index + 1}.`;

                return (
                    `${rank} @${participant.split("@")[0]}\n` +
                    `   💬 Messages: *${stat.msgCount}*`
                );
            }).filter(Boolean);

            if (!lines.length) {
                return await sock.sendMessage(jid, {
                    text:
                        "⚠️ Activity records exist, but no valid participant IDs were found."
                }, { quoted: msg });
            }

            const report =
                `👑 *KING RED AI*\n` +
                `📈 *MOST ACTIVE GROUP MEMBERS*\n\n` +
                lines.join("\n\n") +
                `\n\n━━━━━━━━━━━━━━━━━━\n` +
                `🏆 *TOP ${lines.length} MEMBERS*`;

            await sock.sendMessage(jid, {
                text: report,
                mentions: [...new Set(mentions)]
            }, { quoted: msg });

        } catch (err) {
            console.error("[Activity Command Error]", err);

            await sock.sendMessage(jid, {
                text:
                    "❌ Failed to generate the activity report.\n\n" +
                    "Check the Render logs and verify the MessageLog database model."
            }, { quoted: msg });
        }
    }
};
            
