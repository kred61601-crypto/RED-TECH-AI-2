
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
        // React immediately before database work.
        const react = async (emoji) => {
            try {
                if (msg?.key) {
                    await sock.sendMessage(jid, {
                        react: {
                            text: emoji,
                            key: msg.key
                        }
                    });
                }
            } catch (error) {
                console.error("[Activity Reaction Error]", error.message);
            }
        };

        await react("⏳");

        try {
            if (!jid || !jid.endsWith("@g.us")) {
                await sock.sendMessage(jid, {
                    text: "❌ This command can only be used in a group."
                }, { quoted: msg });

                await react("❌");
                return;
            }

            let records = [];

            // Get activity from MongoDB when connected.
            if (isOnline() && MessageLog) {
                const stats = await MessageLog.aggregate([
                    {
                        $match: {
                            remoteJid: jid,
                            participant: {
                                $exists: true,
                                $nin: [null, ""]
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

                records = stats.map(item => ({
                    participant: item._id,
                    pushName: item.pushName || "",
                    msgCount: item.msgCount
                }));
            } else {
                // Fallback to the local message cache.
                const logs = messageCache.getAllLogs();

                const counts = new Map();

                for (const log of logs) {
                    if (
                        log?.remoteJid !== jid ||
                        !log?.participant ||
                        !String(log.participant).includes("@")
                    ) {
                        continue;
                    }

                    const participant = log.participant;

                    if (!counts.has(participant)) {
                        counts.set(participant, {
                            participant,
                            pushName: log.pushName || "",
                            msgCount: 0
                        });
                    }

                    counts.get(participant).msgCount++;
                }

                records = [...counts.values()]
                    .sort((a, b) => b.msgCount - a.msgCount)
                    .slice(0, 10);
            }

            if (!records.length) {
                await sock.sendMessage(jid, {
                    text:
                        "📈 *KING RED AI — GROUP ACTIVITY*\n\n" +
                        "No saved messages were found for this group yet.\n\n" +
                        "The bot can only count messages recorded after message logging starts."
                }, { quoted: msg });

                await react("⚠️");
                return;
            }

            const mentions = [];
            const lines = [];

            records.forEach((item, index) => {
                const participant = item.participant;

                if (
                    typeof participant !== "string" ||
                    !participant.includes("@")
                ) {
                    return;
                }

                mentions.push(participant);

                const rank =
                    ["🥇", "🥈", "🥉"][index] || `${index + 1}.`;

                const displayName = item.pushName
                    ? `${item.pushName} (@${participant.split("@")[0]})`
                    : `@${participant.split("@")[0]}`;

                lines.push(
                    `${rank} ${displayName}\n` +
                    `   💬 Messages: *${item.msgCount}*`
                );
            });

            if (!lines.length) {
                await sock.sendMessage(jid, {
                    text: "⚠️ No valid group participant IDs were found in the saved messages."
                }, { quoted: msg });

                await react("⚠️");
                return;
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

            // Report sent successfully.
            await react("✅");

        } catch (error) {
            console.error("[Activity Command Error]", error);

            await react("❌");

            try {
                await sock.sendMessage(jid, {
                    text:
                        "❌ *KING RED AI — ACTIVITY ERROR*\n\n" +
                        "I couldn't generate the activity report.\n" +
                        "Please check the Render logs for the database error."
                }, { quoted: msg });
            } catch (sendError) {
                console.error(
                    "[Activity Error Reply]",
                    sendError.message
                );
            }
        }
    }
};
    
