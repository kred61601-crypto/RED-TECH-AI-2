
"use strict";

const mediaApi = require("../../lib/mediaApi");

const MAX_VIDEO_SIZE = 45 * 1024 * 1024;

function isTikTokUrl(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();

        return (
            ["http:", "https:"].includes(url.protocol) &&
            (
                host === "tiktok.com" ||
                host.endsWith(".tiktok.com") ||
                host === "vt.tiktok.com" ||
                host === "vm.tiktok.com"
            )
        );
    } catch {
        return false;
    }
}

module.exports = {
    name: "tiktok",
    aliases: ["tt", "tikdl"],
    description: "Download a public TikTok video",
    category: "download",

    async execute({ sock, jid, args = [], msg }) {
        const url = args[0];

        if (!url || !isTikTokUrl(url)) {
            return sock.sendMessage(jid, {
                text:
                    "╭━━━〔 🎵 TIKTOK DOWNLOADER 〕━━━╮\n" +
                    "┃ ❌ Please send a valid TikTok link.\n┃\n" +
                    "┃ Example:\n" +
                    "┃ .tiktok https://www.tiktok.com/@user/video/123\n" +
                    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯"
            }, { quoted: msg });
        }

        let statusMessage;

        try {
            statusMessage = await sock.sendMessage(jid, {
                text: "⏳ *REDTECH-AI is downloading your TikTok...*\nPlease wait."
            }, { quoted: msg });

            const result = await mediaApi.tiktokDownload(url);

            if (!result) {
                throw new Error(
                    "The downloader returned no media. The video may be private or the provider unavailable."
                );
            }

            const buffer = result.buffer;

            if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
                if (buffer.length > MAX_VIDEO_SIZE) {
                    throw new Error("The video exceeds the bot's upload size limit.");
                }

                await sock.sendMessage(jid, {
                    video: buffer,
                    mimetype: "video/mp4",
                    caption:
                        "╭━━━〔 🎵 TIKTOK DOWNLOADER 〕━━━╮\n" +
                        `┃ 👤 Author: ${result.author || "TikTok creator"}\n` +
                        `┃ 🎬 Title: ${result.title || "TikTok video"}\n` +
                        "┃ 💧 No-watermark media if provided by source\n" +
                        "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n" +
                        "👑 REDTECH-AI MD • Powered by Denzel"
                }, { quoted: msg });

                return;
            }

            // A URL alone is not a downloaded video. Tell the user clearly.
            if (result.url) {
                throw new Error(
                    "A video link was found, but the bot could not download the video bytes. Check the downloader API or server network."
                );
            }

            throw new Error("No video file was returned.");
        } catch (error) {
            console.error("[REDTECH TIKTOK ERROR]", error?.stack || error);

            await sock.sendMessage(jid, {
                text:
                    "╭━━━〔 ❌ TIKTOK DOWNLOAD FAILED 〕━━━╮\n" +
                    "┃ The video could not be downloaded.\n┃\n" +
                    "┃ Try a public TikTok video link.\n" +
                    "┃ If it still fails, the download provider\n" +
                    "┃ may be unavailable or blocked.\n" +
                    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n\n" +
                    "⚡ REDTECH-AI MD"
            }, { quoted: msg });
        }
    }
};
