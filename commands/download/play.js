
const axios = require("axios");
const yts = require("yt-search");

const BOT_NAME = "RED TECH AI";

module.exports = {
  name: "play",
  aliases: ["ply", "playy", "pl"],
  description: "Search and download songs as audio",
  category: "download",

  execute: async (ctx) => {
    const { sock, jid, msg } = ctx;
    const query = String(ctx.text || ctx.args?.join(" ") || "").trim();

    const reply = (text) =>
      sock.sendMessage(jid, { text }, { quoted: msg });

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, {
          react: { text: emoji, key: msg.key }
        });
      } catch {}
    };

    try {
      if (!query) {
        return reply(
          `🎵 *${BOT_NAME} AUDIO*\n\n` +
          "Usage: .play song name\n" +
          "Example: .play Binti Kiziwe\n" +
          "You can also provide a YouTube link."
        );
      }

      await react("⏳");

      let video;
      if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(query)) {
        const result = await yts({ videoId: query.match(/(?:v=|youtu\.be\/)([^&?/]+)/)?.[1] });
        video = result;
      } else {
        video = (await yts(query)).videos?.[0];
      }

      if (!video?.url) {
        await react("❌");
        return reply("❌ No YouTube video found.");
      }

      // Replace this with your verified AUDIO downloader endpoint.
      const endpoint = process.env.YT_AUDIO_API;
      if (!endpoint) {
        await react("❌");
        return reply(
          "⚠️ Audio downloader API is not configured.\n" +
          "Set YT_AUDIO_API to a working provider endpoint."
        );
      }

      const response = await axios.get(endpoint, {
        params: { url: video.url, query: video.url },
        timeout: 60000
      });

      const data = response.data;
      const findUrl = (obj) => {
        if (!obj || typeof obj !== "object") return null;
        for (const [key, value] of Object.entries(obj)) {
          if (
            typeof value === "string" &&
            /^(downloadUrl|download_url|audioUrl|audio_url|url|link)$/i.test(key) &&
            /^https?:\/\//i.test(value)
          ) return value;
          if (value && typeof value === "object") {
            const found = findUrl(value);
            if (found) return found;
          }
        }
        return null;
      };

      const audioUrl = findUrl(data);
      if (!audioUrl) {
        console.error("[PLAY API RESPONSE]", JSON.stringify(data).slice(0, 2000));
        await react("❌");
        return reply("❌ The audio service did not return a download link.");
      }

      const file = await axios.get(audioUrl, {
        responseType: "arraybuffer",
        timeout: 120000,
        maxContentLength: 25 * 1024 * 1024
      });

      const audio = Buffer.from(file.data);
      if (!audio.length) throw new Error("Empty audio file");

      await sock.sendMessage(jid, {
        audio,
        mimetype: "audio/mpeg",
        fileName: `${String(video.title || "song").replace(/[^\w -]/g, "").slice(0, 80)}.mp3`,
        ptt: false
      }, { quoted: msg });

      await react("✅");
    } catch (error) {
      console.error("[PLAY ERROR]", error.response?.data || error.message);
      await react("❌");
      await reply("❌ Audio download failed. Check your configured downloader API and Render logs.");
    }
  }
};
        
