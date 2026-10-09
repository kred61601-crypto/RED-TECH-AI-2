const mediaApi = require("../../lib/mediaApi");

module.exports = {
    name: "tiktok",
    aliases: ["tt"],
    description: "Download TikTok videos without watermark.",
    category: "download",

    async execute({ sock, jid, args, msg }) {
        const react = async (emoji) => {
            if (!msg?.key) return;
            await sock.sendMessage(jid, {
                react: {
                    text: emoji,
                    key: msg.key
                }
            }).catch(() => {});
        };

        try {
            // Extract the TikTok link
            const url = String(args?.[0] || "").trim();

            if (!url) {
                await sock.sendMessage(jid, {
                    text: "❓ *TikTok Downloader*\n\nUsage: .tiktok <TikTok link>\n\nExample: .tiktok https://www.tiktok.com/@user/video/123456789"
                }, { quoted: msg });
                return;
            }

            let parsedUrl;

            try {
                parsedUrl = new URL(url);
            } catch {
                await sock.sendMessage(jid, {
                    text: "❌ Please provide a valid TikTok link."
                }, { quoted: msg });
                return;
            }

            const hostname = parsedUrl.hostname.toLowerCase();

            if (
                !["tiktok.com", "www.tiktok.com", "m.tiktok.com",
                  "vm.tiktok.com", "vt.tiktok.com"].includes(hostname)
            ) {
                await sock.sendMessage(jid, {
                    text: "❌ That is not a supported TikTok link."
                }, { quoted: msg });
                return;
            }

            // ⏳ React immediately to the command
            await react("⏳");

            await sock.sendMessage(jid, {
                text: "🎬 *RED TECH AI TikTok Downloader*\n\n⏳ Processing your video. Please wait..."
            }, { quoted: msg });

            // Call the existing downloader API
            if (typeof mediaApi.tiktokDownload !== "function") {
                throw new Error(
                    "mediaApi.tiktokDownload is missing from lib/mediaApi.js"
                );
            }

            const result = await mediaApi.tiktokDownload(url);

            if (!result) {
                await react("❌");
                await sock.sendMessage(jid, {
                    text: "❌ Could not retrieve the video. The link may be private, unavailable, or unsupported by the downloader API."
                }, { quoted: msg });
                return;
            }

            // Support common downloader response formats
            const videoUrl =
                typeof result === "string"
                    ? result
                    : result.url ||
                      result.videoUrl ||
                      result.downloadUrl ||
                      result.play ||
                      result.data?.url ||
                      result.data?.videoUrl ||
                      null;

            let buffer =
                Buffer.isBuffer(result.buffer)
                    ? result.buffer
                    : Buffer.isBuffer(result.data)
                        ? result.data
                        : null;

            // Support base64 data returned by an API
            if (!buffer && typeof result.buffer === "string") {
                const base64 = result.buffer.replace(
                    /^data:video\/[^;]+;base64,/i, ""
                );

                try {
                    buffer = Buffer.from(base64, "base64");
                    if (!buffer.length) buffer = null;
                } catch {
                    buffer = null;
                }
            }

            // Some APIs return a direct MP4 URL instead of a buffer
            if (!buffer && !videoUrl) {
                throw new Error(
                    "The downloader returned no video buffer or usable URL."
                );
            }

            const author =
                typeof result === "object"
                    ? result.author ||
                      result.username ||
                      result.data?.author ||
                      "Unknown"
                    : "Unknown";

            const caption =
                `🎬 *RED TECH AI — TikTok Downloader*\n\n` +
                `👤 *Author:* ${author}\n` +
                `📦 *Format:* TikTok video\n` +
                `✅ *Download complete*`;

            // Deliver the actual video
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(jid, {
                    video: buffer,
                    mimetype: "video/mp4",
                    caption
                }, { quoted: msg });
            } else {
                await sock.sendMessage(jid, {
                    video: { url: videoUrl },
                    mimetype: "video/mp4",
                    caption
                }, { quoted: msg });
            }

            // ✅ Only react with a tick after video delivery succeeds
            await react("✅");

        } catch (err) {
            console.error("❌ TikTok Downloader Error:", err);

            await react("❌");

            await sock.sendMessage(jid, {
                text:
                    "❌ *TikTok Download Failed*\n\n" +
                    "The downloader could not retrieve or send this video.\n\n" +
                    "Please check that:\n" +
                    "• The TikTok video is public.\n" +
                    "• Your downloader API is online.\n" +
                    "• The API returns a valid video buffer or direct video URL.\n\n" +
                    `⚠️ *Error:* ${String(err.message || err).slice(0, 250)}`
            }, { quoted: msg }).catch(() => {});
        }
    }
};
