
const { ownerNumbers, admins } = require("../config");
const botContext = require("./botContext");

// Cache group metadata briefly to reduce repeated network requests.
const groupMetadataCache = new Map();
const GROUP_CACHE_TTL = 15_000;
const MAX_GROUP_CACHE = 500;

const isSudo = (sender) => {
    if (!sender || !process.env.SUDO) return false;

    const senderDigits = sender.replace(/\D/g, "");
    const sudoDigits = process.env.SUDO.replace(/\D/g, "");

    return Boolean(sudoDigits && senderDigits === sudoDigits);
};

const isOwner = (sender) => {
    if (!sender) return false;
    if (isSudo(sender)) return true;

    const senderDigits = sender.replace(/\D/g, "");
    if (!senderDigits) return false;

    const ctx = botContext.getStore();
    const myJid = (ctx && ctx.myJid) || global.myJid;

    if (myJid) {
        const botDigits = myJid.replace(/\D/g, "");
        if (senderDigits === botDigits) return true;
    }

    return ownerNumbers.some((number) => {
        const digits = String(number).replace(/\D/g, "");
        return digits && senderDigits === digits;
    });
};

async function getGroupMetadataCached(sock, jid) {
    const now = Date.now();
    const cached = groupMetadataCache.get(jid);

    if (cached && now - cached.time < GROUP_CACHE_TTL) {
        return cached.metadata;
    }

    const metadata = await sock.groupMetadata(jid);

    if (metadata) {
        if (groupMetadataCache.size >= MAX_GROUP_CACHE) {
            const oldestKey = groupMetadataCache.keys().next().value;
            if (oldestKey) groupMetadataCache.delete(oldestKey);
        }

        groupMetadataCache.set(jid, {
            metadata,
            time: now
        });
    }

    return metadata;
}

const isAdmin = async (sender, jid = null, sock = null) => {
    if (!sender) return false;
    if (isOwner(sender)) return true;

    const senderUser = sender.split("@")[0].split(":")[0];

    const isGlobalAdmin = admins.some((admin) => {
        const adminUser = String(admin).split("@")[0].split(":")[0];
        return adminUser && adminUser === senderUser;
    });

    if (isGlobalAdmin) return true;

    if (jid && jid.endsWith("@g.us") && sock) {
        try {
            const metadata = await getGroupMetadataCached(sock, jid);
            const participants = metadata?.participants || [];

            return participants.some((participant) => {
                const participantUser = String(participant.id || "")
                    .split("@")[0]
                    .split(":")[0];

                return (
                    participantUser === senderUser &&
                    (participant.admin === "admin" ||
                     participant.admin === "superadmin")
                );
            });
        } catch (error) {
            console.error(
                "⚠️ Error checking group admin status:",
                error.message
            );
        }
    }

    return false;
};

const Middlewares = {
    sudoOnly: async (ctx) => {
        if (!isSudo(ctx.sender)) {
            return {
                ok: false,
                reply: "🔒 *Strict Security:* This command is restricted to the Super-Admin (SUDO) only."
            };
        }

        return { ok: true };
    },

    ownerOnly: async (ctx) => {
        if (!isOwner(ctx.sender)) {
            return {
                ok: false,
                reply: "❌ This command is for the bot owner only."
            };
        }

        return { ok: true };
    },

    adminOnly: async (ctx) => {
        if (!await isAdmin(ctx.sender, ctx.jid, ctx.sock)) {
            return {
                ok: false,
                reply: "❌ This command is for admins only."
            };
        }

        return { ok: true };
    },

    groupOnly: async (ctx) => {
        if (!ctx.isGroup) {
            return {
                ok: false,
                reply: "⚠️ This command can only be used in a group."
            };
        }

        return { ok: true };
    }
};

async function runMiddleware(ctx, command) {
    const sudoCheck = command.isSudoOnly || command.sudoOnly;
    const ownerCheck = command.isOwnerOnly || command.ownerOnly;
    const adminCheck = command.isAdminOnly || command.adminOnly;
    const groupCheck = command.isGroupOnly || command.groupOnly;
    const isBotAdminCheck = command.isBotAdmin || command.botAdmin;

    const deny = async (message, logMessage) => {
        console.log(logMessage);
        await ctx.sock.sendMessage(ctx.jid, { text: message });
        return false;
    };

    if (sudoCheck && !isSudo(ctx.sender)) {
        return deny(
            "🔒 *Security Denied:* This command is restricted to the Super-Admin (SUDO) as defined in .env.",
            `🚫 Middleware: Blocked ${ctx.sender} from SUDO-only command ${command.name}`
        );
    }

    if (ownerCheck && !isOwner(ctx.sender)) {
        return deny(
            "❌ *Access Denied:* This command is restricted to the bot owner only.",
            `🚫 Middleware: Blocked ${ctx.sender} from owner-only command ${command.name}`
        );
    }

    if (adminCheck && !await isAdmin(ctx.sender, ctx.jid, ctx.sock)) {
        return deny(
            "❌ *Access Denied:* This command is restricted to group admins only.",
            `🚫 Middleware: Blocked ${ctx.sender} from admin-only command ${command.name}`
        );
    }

    if (groupCheck && !ctx.isGroup) {
        return deny(
            "⚠️ *Group Only:* Use this command inside a group!",
            `🚫 Middleware: Blocked ${command.name} outside a group`
        );
    }

    if (isBotAdminCheck && ctx.isGroup) {
        const botJid =
            ctx.sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

        if (!ctx.sock.user?.id ||
            !await isAdmin(botJid, ctx.jid, ctx.sock)) {
            return deny(
                "⚠️ *Error:* I need to be a group admin to run this command!",
                `🚫 Middleware: Bot is not an admin for ${command.name}`
            );
        }
    }

    if (Array.isArray(command.middlewares)) {
        for (const middleware of command.middlewares) {
            const result = await middleware(ctx, {
                isOwner,
                isAdmin,
                isSudo
            });

            if (result?.ok === false) {
                if (result.reply) {
                    await ctx.sock.sendMessage(ctx.jid, {
                        text: result.reply
                    });
                }

                return false;
            }
        }
    }

    return true;
}

// Call this when a bot disconnects or group membership changes.
function clearGroupMetadataCache(jid) {
    if (jid) {
        groupMetadataCache.delete(jid);
    } else {
        groupMetadataCache.clear();
    }
}

module.exports = {
    runMiddleware,
    isOwner,
    isAdmin,
    isSudo,
    Middlewares,
    clearGroupMetadataCache
};
            
