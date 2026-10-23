
'use strict';

// lib/vv2EmojiTrigger.js
// VV2 emoji reply trigger for KING RED AI / REDTECH AI.

const TRIGGER_EMOJIS = new Set([
    '😘', '❤️', '❤', '🥳', '🤗', '🥰', '😂',
    '💘', '💞', '😍', '😜', '😋', '😻', '🔥',
    '⚡', '🥵', '💗', '❣️', '❣', '🤣', '😊'
]);

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

function unwrapMessage(message) {
    let current = message;

    // Unwrap common WhatsApp message wrappers.
    for (let i = 0; i < 6 && current; i++) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
        } else if (current.viewOnceMessage?.message) {
            // Deliberately do not extract View Once media.
            return { viewOnce: true, message: current.viewOnceMessage.message };
        } else if (current.viewOnceMessageV2?.message) {
            return { viewOnce: true, message: current.viewOnceMessageV2.message };
        } else if (current.viewOnceMessageV2Extension?.message) {
            return { viewOnce: true, message: current.viewOnceMessageV2Extension.message };
        } else {
            break;
        }
    }

    return { viewOnce: false, message: current || {} };
}

function getQuotedMessage(msg) {
    const message = msg?.message || {};

    const contextInfo =
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.audioMessage?.contextInfo ||
        message.buttonsResponseMessage?.contextInfo ||
        message.templateButtonReplyMessage?.contextInfo;

    return contextInfo?.quotedMessage || null;
}

function getMessageText(message) {
    const unwrapped = unwrapMessage(message);
    if (unwrapped.viewOnce) return '';

    const m = unwrapped.message || {};

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        ''
    );
}

function normalizeEmoji(text) {
    return String(text || '')
        .trim()
        .replace(/\uFE0F/g, '');
}

function findUrls(text) {
    return [...new Set(
        (String(text || '').match(URL_REGEX) || [])
            .map(url => url.replace(/[),.!?]+$/g, ''))
    )];
}

/**
 * Returns true when a reply was handled.
 *
 * enabled must come from the bot's own per-user store/settings.
 * The destination is the linked WhatsApp account's own chat.
 */
async function handleVV2EmojiReply(sock, msg, { enabled = false } = {}) {
    if (!enabled || !sock || !msg?.message || !msg?.key) {
        return false;
    }

    // Ignore the bot's own messages.
    if (msg.key.fromMe) return false;

    const emoji = normalizeEmoji(getMessageText(msg));

    if (!TRIGGER_EMOJIS.has(emoji)) return false;

    const quoted = getQuotedMessage(msg);
    if (!quoted) return false;

    const { viewOnce } = unwrapMessage(quoted);

    // Do not retrieve or forward protected View Once media.
    if (viewOnce) {
        const destination = sock.myJid;
        if (!destination) return true;

        await sock.sendMessage(destination, {
            text:
                '🛡️ VV2 received your emoji reply, but the quoted message is ' +
                'WhatsApp View Once media. I will not bypass its privacy ' +
                'protection. Ask the sender to share the media normally if ' +
                'you need a copy.'
        });

        return true;
    }

    const quotedText = getMessageText(quoted);
    const urls = findUrls(quotedText);

    if (!urls.length) return false;

    const destination = sock.myJid;
    if (!destination) {
        console.warn('VV2: sock.myJid is not set; cannot DM the linked account.');
        return true;
    }

    await sock.sendMessage(destination, {
        text:
            `✨ *VV2 — Emoji Reply Detected*\n\n` +
            `Emoji: ${emoji}\n` +
            `Chat: ${msg.key.remoteJid}\n\n` +
            urls.map((url, i) => `${i + 1}. ${url}`).join('\n')
    });

    return true;
}

module.exports = { handleVV2EmojiReply };
