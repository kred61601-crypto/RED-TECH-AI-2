// commands/download/play.js
// RED TECH AI - Audio Downloader

const axios = require("axios");
const yts = require("yt-search");

module.exports = {
  name: "play",
  aliases: ["ply", "playy", "pl"],
  description: "Search and download songs from YouTube",
  category: "download",

  execute: async (context) => {
    const { sock, jid, msg, text } = context;

    const reply = async (message) => {
      return sock.sendMessage(
        jid,
        { text: message },
        { quoted: msg }
      );
    };

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, {
          react: { text: emoji, key: msg.key }
        });
      } catch {}
    };

    try {
      const query = (text || "").trim();

      if (!query) {
        return reply(
          "🎧 *RED TECH AI — AUDIO DOWNLOADER*\n\n" +
          "Use: .play song name\n" +
          "Example: .play Nawaza by Diamond Platnumz\n\n" +
          "You can also send a YouTube link."
        );
      }

      await react("⏳");

      // Search for the song
      const search = await yts(query);
      const video = search.videos?.[0];

      if (!video) {
        await react("❌");
        return reply("❌ No song found. Try another song title.");
      }

      const title = video.title || "Unknown Song";
      const artist = video.author?.name || "Unknown Artist";
      const duration = video.timestamp || "Unknown";
      const views = Number(video.views || 0).toLocaleString();
      const videoUrl = video.url;
      const thumbnail = video.thumbnail;

      // Send the information card while downloading
      const caption =
        "• *AUDIO DOWNLOADER* 🎧\n" +
        "┏━━━⪼\n" +
        `┃ 🎵 *Title* - ${title}\n` +
        `┃ ⏱️ *Duration* - ${duration}\n` +
        `┃ 👁️ *Views* - ${views}\n` +
        `┃ 👤 *Author* - ${artist}\n` +
        "┃ 📥 *Status* - Downloading...\n" +
        "┗━━━⪼\n\n" +
        "Powered by *RED TECH AI* 👑";

      try {
        await sock.sendMessage(
          jid,
          {
            image: { url: thumbnail },
            caption
          },
          { quoted: msg }
        );
      } catch {
        await reply(caption);
      }

      // Request the audio download from the API
      const api =
        "https://apiziaul.vercel.app/api/downloader/ytplaymp3?query=" +
        encodeURIComponent(videoUrl);

      const response = await axios.get(api, {
        timeout: 60000,
        headers: { Accept: "application/json" }
      });

      const data = response.data;

      const audioUrl =
        data?.result?.downloadUrl ||
        data?.result?.url ||
        data?.downloadUrl ||
        data?.url ||
        data?.result?.download?.url;

      if (!data?.status || !audioUrl) {
        await react("❌");
        return reply(
          "❌ *RED TECH AI*\n\n" +
          "The song was found, but the audio service did not provide a download link. Try again later."
        );
      }

      // Download the audio
      const audioResponse = await axios.get(audioUrl, {
        responseType: "arraybuffer",
        timeout: 120000,
        maxContentLength: 25 * 1024 * 1024,
        maxBodyLength: 25 * 1024 * 1024
      });

      const audio = Buffer.from(audioResponse.data);

      if (!audio.length) {
        throw new Error("Audio download returned an empty file.");
      }

      const safeTitle = title
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .slice(0, 100);

      await sock.sendMessage(
        jid,
        {
          audio,
          mimetype: "audio/mpeg",
          fileName: `${safeTitle}.mp3`
        },
        { quoted: msg }
      );

      await react("✅");

    } catch (error) {
      console.error(
        "[RED TECH AI PLAY ERROR]",
        error.response?.data || error.message || error
      );

      await react("❌");
      await reply(
        "❌ *RED TECH AI*\n\n" +
        "Sorry, the song could not be downloaded. The download service may be unavailable. Please try again."
      ).catch(() => {});
    }
  }
};
