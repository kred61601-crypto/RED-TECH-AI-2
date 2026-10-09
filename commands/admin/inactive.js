const { MessageLog } = require("../../redtech/messageModel");
const { isOnline } = require("../../redtech/db");
const messageCache = require("../../lib/messageCache");

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const MAX_MENTIONS = 30;

module.exports = {
    name: "inactive",
    aliases: ["inactives", "sleeping"],
    description: "Lists members who haven't sent a message in 3 days.",
    category: "admin",
    adminOnly: true,
    groupOnly: true,

    async execute({ sock, jid, msg }) {
        // React immediately when .inactive is used.
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
                console.error("[Inactive Reaction Error]", error.message);
            }
        };

        await react("⏳");

        try {
            if (!jid || !jid.endsWith("@g.us")) {
                await sock.sendMessage(
                    jid,
                    { text: "❌ This command can only be used in a group." },
                    { quoted: msg }
                );
                await react("❌");
                return;
            }

            const metadata = await sock.groupMetadata(jid);
            const participants = metadata.participants || [];

            const botNumber = sock.user?.id
                ?.split(":")[0]
                ?.split("@")[0];

            const members = participants
                .map((p) => p.id || p.jid)
                .filter(Boolean)
                .filter((id) => {
                    const number = id.split("@")[0].split(":")[0];
                    return !botNumber || number !== botNumber;
                });

            if (!members.length) {
                await sock.sendMessage(
                    jid,
                    { text: "⚠️ No group members were found." },
                    { quoted: msg }
                );
                await react("⚠️");
                return;
            }

            const cutoffSeconds = Math.floor(
                (Date.now() - THREE_DAYS) / 1000
            );

            const activeMembers = new Set();

            if (isOnline() && MessageLog) {
                const records = await MessageLog.aggregate([
                    {
                        $match: {
                            remoteJid: jid,
                            timestamp: { $gte: cutoffSeconds },
                            participant: {
                                $exists: true,
                                $nin: [null, ""]
                            }
                        }
                    },
                    {
                        $group: {
                            _id: "$participant"
                        }
                    }
                ]);

                for (const record of records) {
                    if (record._id) {
                        activeMembers.add(normalizeJid(record._id));
                    }
                }
            } else {
                const logs =
                    typeof messageCache.getAllLogs === "function"
                        ? messageCache.getAllLogs()
                        : [];

                for (const log of logs) {
                    if (
                        log?.remoteJid !== jid ||
                        !log?.participant ||
                        !isRecent(log.timestamp, cutoffSeconds)
                    ) {
                        continue;
                    }

                    activeMembers.add(normalizeJid(log.participant));
                }
            }

            const inactiveMembers = members.filter(
                (member) => !activeMembers.has(normalizeJid(member))
            );

            if (inactiveMembers.length === 0) {
                await sock.sendMessage(
                    jid,
                    {
                        text:
                            "✅ *KING RED AI — GROUP ACTIVITY*\n\n" +
                            "Everyone has sent a message within the last 3 days."
                    },
                    { quoted: msg }
                );

                await react("✅");
                return;
            }

            const listedMembers = inactiveMembers.slice(0, MAX_MENTIONS);

            const memberLines = listedMembers.map((member, index) => {
                const number = member.split("@")[0].split(":")[0];
                return `${index + 1}. @${number}`;
            });

            let report =
                "👑 *KING RED AI*\n" +
                "💤 *INACTIVE GROUP MEMBERS*\n" +
                "━━━━━━━━━━━━━━━━━━\n\n" +
                "📅 Inactive period: *3 days*\n" +
                `👥 Inactive members: *${inactiveMembers.length}*\n\n` +
                memberLines.join("\n");

            if (inactiveMembers.length > MAX_MENTIONS) {
                report +=
                    `\n\n_...and ${inactiveMembers.length - MAX_MENTIONS} more members._`;
            }

            report +=
                "\n\n━━━━━━━━━━━━━━━━━━\n" +
                "_Only messages recorded by the bot can be counted._";

            await sock.sendMessage(
                jid,
                {
                    text: report,
                    mentions: listedMembers
                },
                { quoted: msg }
            );

            await react("✅");

        } catch (error) {
            console.error("[Inactive Command Error]", error);

            await react("❌");

            try {
                await sock.sendMessage(
                    jid,
                    {
                        text:
                            "❌ *KING RED AI — INACTIVE ERROR*\n\n" +
                            "Couldn't generate the inactive members report. " +
                            "Please check the Render logs."
                    },
                    { quoted: msg }
                );
            } catch (sendError) {
                console.error("[Inactive Reply Error]", sendError.message);
            }
        }
    }
};

function normalizeJid(jid) {
    if (typeof jid !== "string") return "";
    return jid.split(":")[0].toLowerCase();
}

function isRecent(timestamp, cutoffSeconds) {
    if (timestamp === undefined || timestamp === null) return false;

    let seconds = Number(timestamp);

    // Convert milliseconds to seconds if necessary.
    if (seconds > 1e12) {
        seconds = Math.floor(seconds / 1000);
    }

    return seconds >= cutoffSeconds;
        }
