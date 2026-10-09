
const { MessageLog } = require("../../redtech/messageModel");
const { isOnline } = require("../../redtech/db");
const messageCache = require("../../lib/messageCache");

module.exports = {
    name: "activity",
    aliases: ["active", "topmembers"],
    description: "Show the most active members in the group.",
    category: "admin",
    adminOnly: true,
    groupOnly: true,

    async execute({ sock, jid, msg }) {
        try {
            if (!jid || !jid.endsWith("@g.us")) {
                return await sock.sendMessage(jid, {
                    text: "❌ This command can only be used in a group."
                }, { quoted: msg });
            }

            let stats = [];

            // Preferred method: query MongoDB.
            if (isOnline() && MessageLog) {
                stats = await MessageLog.aggregate([
                    {
                        $match: {
                            remoteJid: jid,
                            participant: {
                                $exists: true,
                                $ne: null,
                                $not: { $eq: "" }
                            }
                        }
                    },
                    {
                        $group: {
                            _id: "$participant",
                            msgCount: { $sum: 1 },
                            pushName: { $last: "$pushName" }
                        }
                    },
                    { $sort: { msgCount: -1 } },
                    { $limit: 10 }
                ]);
            } else {
                // Offline fallback: support common cache APIs if exposed.
                let logs = [];

                if (messageCache && typeof messageCache.getAllLogs === "function") {
                    logs = await messageCache.getAllLogs();
                } else if (messageCache && messageCache.logs instanceof Map) {
                    logs = Array.from(messageCache.logs.values());
                } else if (messageCache && messageCache.logs instanceof Array) {
                    logs = messageCache.logs;
                }

                const counts = new Map();

                for (const log of logs) {
                    if (log?.remoteJid !== jid || !log?.participant) continue;

                    const existing = counts.get(log.participant) || {
                        _id: log.participant,
                        msgCount: 0,
                        pushName: log.pushName || ""
                    };

                    existing.msgCount += 1;
                    counts.set(log.participant, existing);
                }

                stats = Array.from(counts.values())
                    .sort((a, b) => b.msgCount - a.msgCount)
                    .slice(0, 10);
            }

            if (!stats.length) {
                return await sock.sendMessage(jid, {
                    text:
                        "📈 *KING RED AI — GROUP ACTIVITY*\n\n" +
                        "No saved group messages were found yet.\n\n" +
                        "Make sure message logging is running and MongoDB is connected. " +
                        "This report can only count messages saved by the bot."
                }, { quoted: msg });
            }

            const mentions = [];
            const lines = [];

            stats.forEach((stat, index) => {
                const participant = stat._id;

                if (
                    typeof participant !== "string" ||
                    !participant.includes("@")
                ) return;

                mentions.push(participant);

                const medal = ["🥇", "🥈", "🥉"][index] || `${index + 1}.`;
                const name = stat.pushName
                    ? `${stat.pushName} (@${participant.split("@")[0]})`
                    : `@${participant.split("@")[0]}`;

                lines.push(
                    `${medal} ${name}\n` +
                    `   💬 Messages: *${stat.msgCount}*`
                );
            });

            if (!lines.length) {
                return await sock.sendMessage(jid, {
                    text: "⚠️ Message records were found, but they don't contain valid participant IDs."
                }, { quoted: msg });
            }

            await sock.sendMessage(jid, {
                text:
                    `👑 *KING RED AI*\n` +
                    `📈 *MOST ACTIVE GROUP MEMBERS*\n\n` +
                    lines.join("\n\n") +
                    `\n\n━━━━━━━━━━━━━━━━━━\n` +
                    `🏆 *TOP ${lines.length} MEMBERS*`,
                mentions: [...new Set(mentions)]
            }, { quoted: msg });

        } catch (err) {
            console.error("[Activity Command Error]", err);

            await sock.sendMessage(jid, {
                text:
                    "❌ Failed to generate the activity report.\n" +
                    "Check the Render logs for the exact database error."
            }, { quoted: msg });
        }
    }
};
                    
