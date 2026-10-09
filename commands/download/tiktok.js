
const mediaApi = require("../../lib/mediaApi");

const MAX_MEDIA_BYTES = 48 * 1024 * 1024;

module.exports = {
    name: "tiktok",
    aliases: ["tt"],
    description: "Download TikTok videos without a watermark.",
    category: "download",

    async execute({ sock, jid, args, msg }) {
        const url = (args || []).join(" ").trim();

        if (!url || !/^https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\//i.test(url)) {
            return sock.sendMessage(
                jid,
                { text: "❓ *Usage:* .tiktok <TikTok link>\n\nExample: .tiktok https://www.tiktok.com/@user/video/123456789" },
                { quoted: msg }
            );
        }

        const react = async (emoji) => {
            try {
                if (msg?.key) {
                    await sock.sendMessage(jid, {
                        react: { text: emoji, key: msg.key }
                    });
                }
            } catch (_) {}
        };

        await react("⏳");

        let progress;
        try {
            progress = await sock.sendMessage(
                jid,
                { text: "⏳ *KING RED AI*\n\nDownloading your TikTok video. Please wait..." },
                { quoted: msg }
            );

            const result = await mediaApi.tiktokDownload(url);

            if (!result) {
                await react("❌");
                return sock.sendMessage(jid, {
                    text: "❌ I couldn't download this TikTok video.\n\nPlease check that:\n• The link is correct.\n• The video is public.\n• The video is still available.\n\nTry another public TikTok link."
                }, { quoted: msg });
            }

            const video = Buffer.isBuffer(result)
                ? result
                : Buffer.isBuffer(result.buffer)
                    ? result.buffer
                    : null;

            if (video && video.length > 0 && video.length <= MAX_MEDIA_BYTES) {
                await sock.sendMessage(jid, {
                    video,
                    mimetype: "video/mp4",
                    caption:
                        `🎬 *KING RED AI — TikTok Downloader*\n\n` +
                        `👤 *Author:* ${result.author || "Unknown"}\n` +
                        `📥 *Download:* Complete`
                }, { quoted: msg });

                await react("✅");
                return;
            }

            if (result.url) {
                await sock.sendMessage(jid, {
                    text:
                        "⚠️ I found a video link, but couldn't safely send the video directly.\n\n" +
                        `🔗 ${result.url}`
                }, { quoted: msg });

                await react("⚠️");
                return;
            }

            await react("❌");
            await sock.sendMessage(jid, {
                text: "❌ The downloader returned no usable video. Please try another link."
            }, { quoted: msg });

        } catch (error) {
            console.error("[TikTok Downloader]", error?.message || error);
            await react("❌");
            await sock.sendMessage(jid, {
                text: "❌ TikTok download failed. Please try again later with a public video link."
            }, { quoted: msg });
        }
    }
};
