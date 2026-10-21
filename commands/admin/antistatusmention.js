const { getSettings, updateSettings } = require("../../lib/settings");
const jsonStore = require("../../redtech/jsonStore");

module.exports = {
    name: "antistatusmention",
    aliases: [
        "antigroupstatusmention",
        "antigroupstatus",
        "antistatus",
        "antitag"
    ],
    description: "Manage group or global anti-status-mention protection",
    category: "admin",
    adminOnly: true,
    groupOnly: true,

    execute: async (ctx) => {
        const { sock, jid, args = [], msg } = ctx;

        // React to the command before sending the command response.
        if (msg?.key && !msg.key.fromMe) {
            try {
                await sock.sendMessage(jid, {
                    react: {
                        text: "⚡",
                        key: msg.key
                    }
                });
            } catch (error) {
                console.error(
                    "[REDTECH] Anti-status command reaction failed:",
                    error.message
                );
            }
        }

        const reply = async (text) => {
            return sock.sendMessage(
                jid,
                { text },
                msg ? { quoted: msg } : {}
            );
        };

        if (!jid || !jid.endsWith("@g.us")) {
            return reply(
                "❌ This command can only be used inside a WhatsApp group."
            );
        }

        const settings = getSettings();
        const action = String(args[0] || "").toLowerCase().trim();
        const target = String(args[1] || "").toLowerCase().trim();

        const localMode = jsonStore.get(
            `antistatusmention_mode_${jid}`,
            null
        );

        const globalMode = settings.antiStatusMentionGlobal || "off";
        const activeMode = localMode !== null ? localMode : globalMode;
        const warnLimit = settings.antiStatusMentionLimit || 3;

        // Help / status panel
        if (!action) {
            const help =
                "🏷️ *REDTECH-AI — ANTI STATUS MENTION*\n" +
                "━━━━━━━━━━━━━━━━━━\n\n" +
                `🔹 *Current Group Mode:* ${String(activeMode).toUpperCase()}` +
                `${localMode === null ? " _(Global inherited)_" : ""}\n` +
                `🔹 *Global Mode:* ${String(globalMode).toUpperCase()}\n` +
                `🔹 *Warn Limit:* ${warnLimit}\n\n` +
                "⚡ *GROUP COMMANDS*\n" +
                "▸ .antistatusmention warn\n" +
                "▸ .antistatusmention delete\n" +
                "▸ .antistatusmention remove\n" +
                "▸ .antistatusmention off\n\n" +
                "🌍 *GLOBAL COMMANDS*\n" +
                "▸ .antistatusmention warn all\n" +
                "▸ .antistatusmention delete all\n" +
                "▸ .antistatusmention remove all\n" +
                "▸ .antistatusmention off all\n\n" +
                "⚙️ *OTHER SETTINGS*\n" +
                "▸ .antistatusmention limit 3\n" +
                "▸ .antistatusmention resetwarns\n\n" +
                "Use these commands as a group admin or bot owner.";

            return reply(help);
        }

        // Reset warnings for members in this group.
        if (
            ["resetwarns", "resetwarn", "clearwarns"].includes(action)
        ) {
            const cache = jsonStore.getAll();
            const prefix = `antistatusmention_warns_${jid}_`;
            let clearedCount = 0;

            for (const key of Object.keys(cache)) {
                if (key.startsWith(prefix)) {
                    delete cache[key];
                    clearedCount++;
                }
            }

            if (clearedCount > 0) {
                jsonStore.save();
            }

            return reply(
                `✅ *Warnings reset.* Cleared ${clearedCount} warning counter(s) for this group.`
            );
        }

        // Configure the warning limit.
        if (["limit", "warnlimit"].includes(action)) {
            const limit = Number.parseInt(args[1], 10);

            if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
                return reply(
                    "⚠️ Set a valid warning limit from 1 to 10.\n" +
                    "Example: .antistatusmention limit 3"
                );
            }

            await updateSettings({
                antiStatusMentionLimit: limit
            });

            return reply(
                `✅ Warning limit updated to *${limit}*.\n` +
                "⚠️ Your automation code must enforce this limit for it to take effect."
            );
        }

        // Configure group or global mode.
        const validModes = ["warn", "delete", "remove", "off"];

        if (validModes.includes(action)) {
            if (target === "all" || target === "global") {
                await updateSettings({
                    antiStatusMentionGlobal: action
                });

                return reply(
                    "✅ *Global anti-status-mention setting updated.*\n\n" +
                    `🌍 Default mode for all groups: *${action.toUpperCase()}*\n` +
                    "Groups with their own saved setting may override this mode."
                );
            }

            jsonStore.set(
                `antistatusmention_mode_${jid}`,
                action
            );

            return reply(
                "✅ *Group anti-status-mention setting updated.*\n\n" +
                `🛡️ Mode: *${action.toUpperCase()}*`
            );
        }

        return reply(
            "⚠️ Unknown command.\n" +
            "Type .antistatusmention to see the help panel."
        );
    }
};
    
