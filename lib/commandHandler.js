// lib/commandHandler.js
// KING RED AI — Command Handler
// CommonJS version

const fs = require("fs");
const path = require("path");

const { prefixes, processedIdLimit } = require("../config");
const { runMiddleware, isOwner: checkIsOwner } = require("./middleware");
const { parseMessage } = require("./messageParser");
const { isOnCooldown, groupSpamGuard } = require("./cooldown");
const { loadPlugins } = require("../plugins/pluginLoader");

// FIX: Load XP model from lib instead of the missing Firebox folder.
const { addXP } = require("./userModel");

const { getSettings } = require("./settings");
const { getGame, processGameInput } = require("./gameState");
const { askGroq, checkAILimit } = require("./aiHelper");

// ── Load commands recursively ────────────────────────────────────────────────

const commands = new Map();
const commandsDir = path.join(__dirname, "../commands");

const loadCommands = () => {
    if (!fs.existsSync(commandsDir)) {
        console.warn("⚠️ Commands directory not found:", commandsDir);
        return;
    }

    const getFilesRecursive = (dir) => {
        let results = [];

        if (!fs.existsSync(dir)) return results;

        for (const file of fs.readdirSync(dir)) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                results = results.concat(getFilesRecursive(filePath));
            } else if (file.endsWith(".js") && !file.endsWith(".example")) {
                results.push(filePath);
            }
        }

        return results;
    };

    const files = getFilesRecursive(commandsDir);

    for (const fullPath of files) {
        const relativePath = path
            .relative(commandsDir, fullPath)
            .replace(/\\/g, "/");

        try {
            const loadedModule = require(fullPath);

            const register = (cmd) => {
                if (
                    !cmd ||
                    typeof cmd !== "object" ||
                    !cmd.name ||
                    typeof cmd.execute !== "function"
                ) {
                    return false;
                }

                if (!cmd.category) cmd.category = "general";

                const cmdName = String(cmd.name).toLowerCase();
                commands.set(cmdName, cmd);

                if (Array.isArray(cmd.aliases)) {
                    for (const alias of cmd.aliases) {
                        if (alias) {
                            commands.set(String(alias).toLowerCase(), cmd);
                        }
                    }
                }

                return true;
            };

            const mainLoaded = register(loadedModule);

            for (const value of Object.values(loadedModule)) {
                if (value && typeof value === "object" && value !== loadedModule) {
                    register(value);
                }
            }

            if (mainLoaded || Object.keys(loadedModule).length > 0) {
                console.log(`📦 Loaded: ${relativePath}`);
            }
        } catch (error) {
            console.error(
                `❌ Error loading command ${relativePath}:`,
                error.message
            );
        }
    }
};

loadCommands();

console.log(
    `✅ KING RED AI loaded ${commands.size} command entries:`,
    [...commands.keys()].join(", ")
);

// ── Load plugins ──────────────────────────────────────────────────────────────

try {
    loadPlugins(commands);
} catch (error) {
    console.error("❌ Plugin loading failed:", error.message);
}

// ── Duplicate-message guard ───────────────────────────────────────────────────

const processedIds = new Set();

function isDuplicate(msgId) {
    if (!msgId) return false;

    if (processedIds.has(msgId)) return true;

    processedIds.add(msgId);

    const maxIds = Number(processedIdLimit) || 1000;

    while (processedIds.size > maxIds) {
        processedIds.delete(processedIds.values().next().value);
    }

    return false;
}

// ── Main message handler ──────────────────────────────────────────────────────

async function handleMessages(sock, { messages, type }) {
    if (type !== "notify") return;

    const msg = messages?.[0];

    if (!msg?.message || !msg.key?.remoteJid) return;

    // Skip messages older than two minutes.
    if (msg.messageTimestamp) {
        let rawTs = msg.messageTimestamp;

        if (typeof rawTs === "object") {
            rawTs = rawTs.toNumber
                ? rawTs.toNumber()
                : rawTs.low || 0;
        }

        rawTs = Number(rawTs);

        if (rawTs > 0) {
            const timestamp = rawTs > 10000000000
                ? Math.floor(rawTs / 1000)
                : rawTs;

            const age = Math.floor(Date.now() / 1000) - timestamp;

            if (age > 120) {
                console.log(`⏳ Skipping old message (${age}s old)`);
                return;
            }
        }
    }

    // ── Identify sender and chat ──────────────────────────────────────────────

    const jid = msg.key.remoteJid;
    const sender = msg.key.fromMe
        ? (sock.myJid || global.myJid || jid)
        : (msg.key.participant || jid);

    const isGroup = jid.endsWith("@g.us");

    if (isDuplicate(msg.key.id)) return;

    // ── Extract normal and interactive messages ───────────────────────────────

    let textBody = "";

    const listResponse =
        msg.message.listResponseMessage ||
        msg.message.buttonsResponseMessage ||
        msg.message.templateButtonReplyMessage;

    if (listResponse) {
        textBody =
            listResponse.singleSelectReply?.selectedRowId ||
            listResponse.selectedButtonId ||
            listResponse.selectedId ||
            "";

        console.log(`🖱️ Interactive selection: ${textBody}`);
    } else {
        const parsed = parseMessage(msg);
        textBody = parsed?.text || "";
    }

    const text = String(textBody);

    // ── Prefix and settings ───────────────────────────────────────────────────

    const settings = getSettings() || {};
    const configuredPrefix = settings.prefix || prefixes?.[0] || ".";

    const availablePrefixes = Array.from(
        new Set([configuredPrefix, ...(prefixes || [])])
    );

    const prefix = availablePrefixes.find(
        (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            text.toLowerCase().startsWith(item.toLowerCase())
    );

    let commandName = "";
    let args = [];

    const textLower = text.trim().toLowerCase();

    const isShortcut = [
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        "10", "11", "12", "13", "14", "15", "16", "17", "18", "19"
    ].includes(textLower);

    const hasGameSession =
        typeof getGame === "function" && Boolean(getGame(jid));

    if (msg.key.fromMe && !prefix && !isShortcut && !hasGameSession) {
        return;
    }

    if (prefix) {
        const cleanText = text.slice(prefix.length).trim();
        const parts = cleanText ? cleanText.split(/\s+/) : [];

        commandName = (parts.shift() || "").toLowerCase();
        args = parts;
    } else {
        // ── Interactive menu/settings replies ─────────────────────────────────

        const contextInfo =
            msg.message?.extendedTextMessage?.contextInfo;

        const quotedParticipant =
            contextInfo?.participant ||
            contextInfo?.remoteJid;

        const botJid = sock.myJid || global.myJid || "";

        const isReplyToBot =
            quotedParticipant === botJid || msg.key.fromMe;

        if (isReplyToBot) {
            const quotedMessage = contextInfo?.quotedMessage;

            const quotedText = (
                quotedMessage?.conversation ||
                quotedMessage?.extendedTextMessage?.text ||
                quotedMessage?.imageMessage?.caption ||
                quotedMessage?.videoMessage?.caption ||
                ""
            ).toLowerCase();

            const isSettingsReply = [
                "settings",
                "reply 0 or .settings to go back",
                "reply 0 to go back",
                "bot configuration",
                "anti-link",
                "anti-tag",
                "anti-status-mention",
                "anti-delete",
                "status anti-delete",
                "anti-call",
                "group events",
                "presence",
                "auto view status",
                "auto reply status",
                "auto read",
                "auto bio",
                "chatbot (ai)",
                "greet (dm auto-reply)",
                "auto react",
                "other commands"
            ].some((term) => quotedText.includes(term));

            const isMainMenuReply =
                quotedText.includes("available categories:") ||
                quotedText.includes("menu") ||
                quotedText.includes("explore by typing .menu");

            if (isSettingsReply) {
                let choice = null;

                if (
                    quotedText.includes("settings") &&
                    (
                        quotedText.includes("to configure:") ||
                        quotedText.includes("reply with")
                    )
                ) {
                    choice = "menu";
                } else if (quotedText.includes("bot configuration")) {
                    choice = 1;
                } else if (quotedText.includes("anti-link")) {
                    choice = 2;
                } else if (
                    quotedText.includes("anti-tag") ||
                    quotedText.includes("anti-status-mention") ||
                    quotedText.includes("antitag")
                ) {
                    choice = 3;
                } else if (quotedText.includes("status anti-delete")) {
                    choice = 5;
                } else if (quotedText.includes("anti-delete")) {
                    choice = 4;
                } else if (quotedText.includes("anti-call")) {
                    choice = 6;
                } else if (quotedText.includes("group events")) {
                    choice = 7;
                } else if (quotedText.includes("presence")) {
                    choice = 8;
                } else if (quotedText.includes("auto view status")) {
                    choice = 9;
                } else if (quotedText.includes("auto reply status")) {
                    choice = 10;
                } else if (quotedText.includes("auto read")) {
                    choice = 11;
                } else if (quotedText.includes("auto bio")) {
                    choice = 12;
                } else if (quotedText.includes("chatbot (ai)")) {
                    choice = 13;
                } else if (quotedText.includes("greet (dm auto-reply)")) {
                    choice = 14;
                } else if (quotedText.includes("auto react")) {
                    choice = 15;
                } else if (quotedText.includes("other commands")) {
                    choice = 16;
                }

                const choiceNum = Number.parseInt(textLower, 10);

                if (choice === "menu") {
                    if (
                        Number.isInteger(choiceNum) &&
                        choiceNum >= 0 &&
                        choiceNum <= 16
                    ) {
                        commandName = "settings";
                        args = [String(choiceNum)];
                    }
                } else if (choice >= 1 && choice <= 16) {
                    if (Number.isInteger(choiceNum)) {
                        commandName = "settings";

                        if (choiceNum === 0) {
                            args = ["0"];
                        } else if (choiceNum === choice) {
                            args = [String(choice), "toggle"];
                        } else if (choiceNum >= 1 && choiceNum <= 16) {
                            args = [String(choiceNum)];
                        }
                    } else {
                        commandName = "settings";
                        args = [String(choice), textLower];
                    }
                }
            } else if (isMainMenuReply) {
                const menuShortcuts = {
                    "1": "admin",
                    "2": "ai",
                    "3": "download",
                    "4": "group",
                    "5": "sticker",
                    "6": "owner",
                    "7": "general",
                    "8": "sports",
                    "10": "anime",
                    "11": "games",
                    "12": "social",
                    "13": "fun",
                    "14": "economy",
                    "15": "media",
                    "16": "system",
                    "17": "textmaker",
                    "18": "religion",
                    "19": "dp"
                };

                if (menuShortcuts[textLower]) {
                    commandName = "menu";
                    args = [menuShortcuts[textLower]];
                } else if (textLower === "9") {
                    commandName = "dev";
                    args = [];
                }
            }
        }
    }

    const command = commands.get(commandName);

    // ── Game input and AI auto-replies ────────────────────────────────────────

    if (!command) {
        const session = getGame(jid);

        if (session) {
            await processGameInput({
                sock,
                jid,
                sender,
                text,
                msg,
                session
            });
            return;
        }

        const isPrivateChat = jid.endsWith("@s.whatsapp.net");

        const isPlainIncomingText =
            !msg.key.fromMe &&
            !prefix &&
            !listResponse &&
            text.trim().length > 0;

        const chatbotEnabledForChat =
            settings.chatbotAI &&
            (isPrivateChat || settings.chatbotAIAll === true);

        if (chatbotEnabledForChat && isPlainIncomingText) {
            const limit = checkAILimit(sender);

            if (!limit.allowed) {
                return sock.sendMessage(
                    jid,
                    { text: limit.reason },
                    { quoted: msg }
                );
            }

            try {
                const reply = await askGroq(
                    text,
                    "You are KING RED AI, a helpful WhatsApp assistant. Answer directly, do not claim to be human, and keep responses concise and safe."
                );

                await sock.sendMessage(
                    jid,
                    { text: reply },
                    { quoted: msg }
                );
            } catch (error) {
                console.error(
                    `⚠️ KING RED AI auto-reply failed for ${jid}:`,
                    error.message
                );
            }
        }

        return;
    }

    // ── Owner and access checks ───────────────────────────────────────────────

    const isOwner = checkIsOwner(sender);

    // ── Group command storm protection ────────────────────────────────────────

    if (isGroup && !isOwner) {
        if (!sock.stormTracker) {
            sock.stormTracker = {};
        }

        const now = Date.now();

        if (!sock.stormTracker[jid]) {
            sock.stormTracker[jid] = {
                count: 0,
                last: now,
                mutedUntil: 0
            };
        }

        const storm = sock.stormTracker[jid];

        if (now < storm.mutedUntil) return;

        if (now - storm.last < 30000) {
            storm.count++;

            if (storm.count > 8) {
                storm.mutedUntil = now + 2 * 60 * 1000;
                storm.count = 0;

                console.log(
                    `🛡️ Command storm detected in ${jid}. Pausing commands for 2 minutes.`
                );

                return sock.sendMessage(jid, {
                    text: "🛡️ *KING RED AI protection:* Too many commands detected. Commands are paused in this group for 2 minutes."
                });
            }
        } else {
            storm.count = 1;
            storm.last = now;
        }
    }

    if (settings.publicMode === false && !isOwner) {
        return sock.sendMessage(jid, {
            text: "🔒 *Access Denied:* KING RED AI is currently in Private Mode."
        });
    }

    if (settings.lockedCommands) {
        const lockedList = settings.lockedCommands
            .split(",")
            .map((item) => item.trim().toLowerCase());

        if (
            lockedList.includes(command.name.toLowerCase()) &&
            !isOwner
        ) {
            return sock.sendMessage(jid, {
                text: `🔒 *Command Locked:* The \`.${command.name}\` command is restricted to owners only.`
            });
        }
    }

    // ── Build command context ─────────────────────────────────────────────────

    const { msg: parsedMsg } = parseMessage(msg);

    const context = {
        sock,
        jid,
        sender,
        text,
        isGroup,
        msg: parsedMsg,
        args,
        commands
    };

    // ── Reward XP ─────────────────────────────────────────────────────────────

    try {
        addXP(sender, 1);
    } catch (error) {
        console.error("⚠️ XP reward failed:", error.message);
    }

    // ── Cooldowns and spam protection ─────────────────────────────────────────

    if (isGroup && groupSpamGuard(jid)) return;

    const cd = isOnCooldown(
        sender,
        commandName,
        command.cooldown ?? 3000
    );

    if (cd.active) {
        return sock.sendMessage(jid, {
            text: `⏳ Slow down! Wait ${Math.ceil(cd.remaining / 1000)}s`
        });
    }

    // ── Execute command ────────────────────────────────────────────────────────

    try {
        console.log(
            `🚀 KING RED AI executing [${commandName}] for ${jid}...`
        );

        const allowed = await runMiddleware(context, command);

        if (!allowed) {
            console.log(
                `⚠️ Command [${commandName}] blocked by middleware.`
            );
            return;
        }

        const sentMsg = await command.execute(context);

        console.log(
            `✅ Command [${commandName}] executed successfully.`
        );

        // ── Auto-delete bot responses when enabled ────────────────────────────

        const currentSettings = getSettings();

        if (
            sentMsg &&
            currentSettings?.autoDelete &&
            !command.noAutoDelete
        ) {
            setTimeout(async () => {
                try {
                    await sock.sendMessage(jid, {
                        delete: sentMsg.key
                    });
                } catch {
                    // The message may already have been deleted.
                }
            }, currentSettings.autoDeleteTime || 30000);
        }
    } catch (error) {
        console.error(
            `⚠️ KING RED AI command error [${commandName}]:`,
            error
        );

        try {
            await sock.sendMessage(
                jid,
                {
                    text:
                        `❌ *Error:* Failed to execute command \`.${commandName}\`.\n\n` +
                        `📝 *Reason:* \`${error.message}\`\n\n` +
                        "_Please verify the command usage or contact the bot owner._"
                },
                { quoted: msg }
            );
        } catch (sendError) {
            console.error(
                "⚠️ Failed to send error notification:",
                sendError.message
            );
        }
    }

    console.log(
        `🏁 KING RED AI finished handling ${commandName}`
    );
}

module.exports = {
    handleMessages,
    commands
};
