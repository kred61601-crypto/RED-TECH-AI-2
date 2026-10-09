
const { getSettings, updateSettings } = require("../../lib/settings");
const jsonStore = require("../../redtech/jsonStore");

const ON = "✅ ON";
const OFF = "❌ OFF";

const bool = (value) => value ? ON : OFF;
const modeLabel = (value) =>
    value === "off" ? "❌ OFF" : `✅ ${String(value || "off").toUpperCase()}`;

const getPanels = (s) => ({
    1: {
        title: "🤖 BOT CONFIGURATION",
        desc: "Customize your bot identity and behavior.",
        status: [
            `🔹 Name: ${s.botName || "Redtech Bot"}`,
            `🔹 Mode: ${s.publicMode ? "public" : "private"}`,
            `🔹 Device: ${s.device || "Android"}`,
            `🔹 Prefix: ${s.prefix || "."}`,
            `🔹 Pack: ${s.packName || "Redtech Bot"}`,
            `🔹 Author: ${s.author || "White Wizard"}`,
            `🔹 Timezone: ${s.timezone || "Africa/Nairobi"}`,
            `🔹 Menu Style: ${s.menuStyle || 1}`
        ].join("\n"),
        usage: "Reply with mode/toggle to switch public/private.\nUse your existing .botname, .prefix, .devicemode, .packname and .author commands to edit values."
    },
    2: {
        title: "🔗 ANTI-LINK",
        desc: "Global anti-link protection.",
        status: `🔹 Global: ${modeLabel(s.antiLinkGlobal)}\n🔹 Warn limit: ${s.antiLinkLimit || 3}`,
        usage: "Reply off, warn, delete or remove to set global mode."
    },
    3: {
        title: "🏷️ ANTI-STATUS-MENTION",
        desc: "Global anti-status-mention configuration.",
        status: `🔹 Global: ${modeLabel(s.antiStatusMentionGlobal)}\n🔹 Warn limit: ${s.antiStatusMentionLimit || 3}`,
        usage: "Reply off, warn, delete or remove to set global mode."
    },
    4: {
        title: "🗑️ ANTI-DELETE",
        desc: "Recover deleted messages.",
        status: `💠 Status: ${bool(s.antiDelete)}`,
        usage: "Reply on, off or toggle."
    },
    5: {
        title: "📊 STATUS ANTI-DELETE",
        desc: "Recover deleted statuses.",
        status: `💠 Status: ${bool(s.statusAntiDelete)}`,
        usage: "Reply on, off or toggle."
    },
    6: {
        title: "📞 ANTI-CALL",
        desc: "Automatically reject incoming calls.",
        status: `💠 Status: ${bool(s.antiCall)}`,
        usage: "Reply on, off or toggle."
    },
    7: {
        title: "🎭 GROUP EVENTS",
        desc: "Welcome, goodbye and promotion event settings.",
        status: `🔹 Global: ${bool(s.groupEventsGlobal)}\n🔹 Promotions: ${bool(s.eventsPromote)}`,
        usage: "Reply on, off or toggle to change global events. Use your existing .events command for per-group settings."
    },
    8: {
        title: "🔄 PRESENCE",
        desc: "Typing/presence indicators.",
        status: `💠 DM Presence: ${bool(s.dmPresence)}\n💠 Group Presence: ${bool(s.groupPresence)}`,
        usage: "Reply dm or grp to toggle that setting."
    },
    9: {
        title: "👁️ AUTO VIEW STATUS",
        desc: "Automatically view status updates.",
        status: `💠 Auto View: ${bool(s.autoViewStatus)}\n💠 Auto React: ${bool(s.autoLikeStatus)}`,
        usage: "Reply on, off or toggle to change auto-view. Use .autostatus for detailed controls."
    },
    10: {
        title: "💬 AUTO REPLY STATUS",
        desc: "Automatically reply to status updates.",
        status: `💠 Status: ${bool(s.autoReplyStatus)}\n💠 Reply text: ${s.statusReplyText || "Nice status! ✨"}`,
        usage: "Reply on, off or toggle."
    },
    11: {
        title: "📖 AUTO READ & PRESENCE",
        desc: "Configure read receipts and presence simulations.",
        status: `💠 Auto Read: ${bool(s.autoRead)}\n💠 Auto Type: ${bool(s.autoType)}\n💠 Auto Record: ${bool(s.autoRecord)}\n💠 Always Online: ${bool(s.alwaysOnline)}`,
        usage: "Reply read, type, record or online to toggle each setting."
    },
    12: {
        title: "📝 AUTO BIO",
        desc: "Automatically rotate your WhatsApp About text.",
        status: `💠 Status: ${bool(s.autoBio)}`,
        usage: "Reply on, off or toggle. Use your existing .setbio command to configure texts."
    },
    13: {
        title: "🤖 CHATBOT AI",
        desc: "AI-powered automatic replies.",
        status: `💠 Status: ${bool(s.chatbotAI)}`,
        usage: "Reply on, off or toggle."
    },
    14: {
        title: "👋 GREET DM",
        desc: "One-time greetings for private contacts.",
        status: `💠 Status: ${bool(s.greetDM)}\n💠 Message: ${s.greetDMMsg || "Hello! 👋"}\n💠 Greeted contacts: ${(jsonStore.get("greeted_users") || []).length}`,
        usage: "Reply on, off or toggle."
    },
    15: {
        title: "😍 AUTO REACT",
        desc: "Automatically react to incoming messages.",
        status: `💠 DM React: ${bool(s.autoReactDM)}\n💠 Group React: ${bool(s.autoReactGrp)}`,
        usage: "Reply dm or grp to toggle."
    },
    16: {
        title: "🔧 OTHER COMMANDS",
        desc: "Additional administration tools.",
        status: "",
        usage: "Use .syncsettings, .allvar, .getvar, .setvar, .systeminfo and .botpic if those commands are installed."
    }
});

const toggleMap = {
    4: { on: { antiDelete: true }, off: { antiDelete: false } },
    5: { on: { statusAntiDelete: true }, off: { statusAntiDelete: false } },
    6: { on: { antiCall: true }, off: { antiCall: false } },
    7: { on: { groupEventsGlobal: true }, off: { groupEventsGlobal: false } },
    9: { on: { autoViewStatus: true }, off: { autoViewStatus: false } },
    10: { on: { autoReplyStatus: true }, off: { autoReplyStatus: false } },
    12: { on: { autoBio: true }, off: { autoBio: false } },
    13: { on: { chatbotAI: true }, off: { chatbotAI: false } },
    14: { on: { greetDM: true }, off: { greetDM: false } }
};

module.exports = {
    name: "settings",
    aliases: ["config", "conf"],
    description: "Manage bot configurations and automation",
    category: "owner",
    isOwnerOnly: true,

    execute: async (ctx) => {
        const { sock, jid, args = [] } = ctx;

        // React before running the settings command.
        const incomingMessage =
            ctx.msg ||
            ctx.message ||
            ctx.m ||
            ctx.messageInfo;

        const messageKey = incomingMessage?.key || ctx.key;

        try {
            if (messageKey && jid) {
                await sock.sendMessage(jid, {
                    react: {
                        text: "⚙️",
                        key: messageKey
                    }
                });
            }
        } catch (error) {
            console.error("[Settings Reaction Error]", error.message);
        }

        try {
            const settings = getSettings();
            const choice = Number.parseInt(args[0], 10);
            const sub = String(args[1] || "").toLowerCase();

            // Main menu
            if (!args.length || choice === 0 || Number.isNaN(choice)) {
                const s = settings;
                const menu = [
                    `⚙️ *${(s.botName || "Redtech Bot").toUpperCase()} SETTINGS*`,
                    "──────────────────────────────",
                    "",
                    "Reply with `.settings <number>` to open a section:",
                    "",
                    `1. 🤖 Bot Configuration — ${s.publicMode ? "Public" : "Private"}`,
                    `2. 🔗 Anti-Link — ${modeLabel(s.antiLinkGlobal)}`,
                    `3. 🏷️ Anti-Status-Mention — ${modeLabel(s.antiStatusMentionGlobal)}`,
                    `4. 🗑️ Anti-Delete — ${bool(s.antiDelete)}`,
                    `5. 📊 Status Anti-Delete — ${bool(s.statusAntiDelete)}`,
                    `6. 📞 Anti-Call — ${bool(s.antiCall)}`,
                    `7. 🎭 Group Events — ${bool(s.groupEventsGlobal)}`,
                    `8. 🔄 Presence — DM: ${bool(s.dmPresence)} | Group: ${bool(s.groupPresence)}`,
                    `9. 👁️ Auto View Status — ${bool(s.autoViewStatus)}`,
                    `10. 💬 Auto Reply Status — ${bool(s.autoReplyStatus)}`,
                    `11. 📖 Auto Read & Presence`,
                    `12. 📝 Auto Bio — ${bool(s.autoBio)}`,
                    `13. 🤖 Chatbot AI — ${bool(s.chatbotAI)}`,
                    `14. 👋 Greet DM — ${bool(s.greetDM)}`,
                    `15. 😍 Auto React`,
                    "16. 🔧 Other Commands",
                    "",
                    "Example: `.settings 4 toggle`"
                ].join("\n");

                return await sock.sendMessage(jid, { text: menu });
            }

            if (choice < 1 || choice > 16) {
                return await sock.sendMessage(jid, {
                    text: "⚠️ Invalid number. Use `.settings` or choose a number from 1 to 16."
                });
            }

            // Apply requested change.
            let changes = {};
            let updated = false;

            if (choice === 1) {
                if (sub === "mode" || sub === "toggle") {
                    changes = { publicMode: !settings.publicMode };
                }
            } else if (choice === 2 || choice === 3) {
                const modes = ["off", "warn", "delete", "remove"];
                if (modes.includes(sub)) {
                    changes = choice === 2
                        ? { antiLinkGlobal: sub }
                        : { antiStatusMentionGlobal: sub };
                } else if (sub === "toggle") {
                    const key = choice === 2 ? "antiLinkGlobal" : "antiStatusMentionGlobal";
                    const current = settings[key] || "off";
                    const next = (modes.indexOf(current) + 1) % modes.length;
                    changes = { [key]: modes[next] };
                }
            } else if (choice === 8) {
                if (sub === "dm") changes = { dmPresence: !settings.dmPresence };
                if (sub === "grp") changes = { groupPresence: !settings.groupPresence };
            } else if (choice === 11) {
                const keys = {
                    read: "autoRead",
                    type: "autoType",
                    record: "autoRecord",
                    online: "alwaysOnline"
                };
                if (keys[sub]) changes = { [keys[sub]]: !settings[keys[sub]] };
                if (sub === "on") changes = { autoRead: true };
                if (sub === "off") changes = { autoRead: false };
            } else if (choice === 15) {
                if (sub === "dm") changes = { autoReactDM: !settings.autoReactDM };
                if (sub === "grp") changes = { autoReactGrp: !settings.autoReactGrp };
            } else if (toggleMap[choice]) {
                if (sub === "on" || sub === "off") {
                    changes = toggleMap[choice][sub] || {};
                } else if (sub === "toggle" || sub === String(choice)) {
                    const key = Object.keys(toggleMap[choice].on)[0];
                    changes = { [key]: !settings[key] };
                }
            }

            if (Object.keys(changes).length) {
                await updateSettings(changes);
                updated = true;
            }

            const latest = getSettings();
            const panel = getPanels(latest)[choice];

            let response = `*${panel.title}*\n`;
            response += "──────────────────────────────\n";
            if (panel.desc) response += `${panel.desc}\n\n`;
            if (panel.status) response += `${panel.status}\n\n`;
            response += `${panel.usage}\n\n`;

            if (updated) {
                response += "✅ *Settings updated.*";
            } else {
                response += "ℹ️ No setting was changed. Reply with a supported option shown above.";
            }

            return await sock.sendMessage(jid, { text: response });
        } catch (error) {
            console.error("[Settings Command Error]", error);
            return await sock.sendMessage(jid, {
                text: "❌ An error occurred while processing settings. Check the bot logs."
            }).catch(() => {});
        }
    }
};
                    
