
const { proto, generateWAMessageFromContent } = require("@whiskeysockets/baileys");

module.exports = {
  name: "channel",
  aliases: ["follow"],
  description: "Show the official WhatsApp Channel",
  category: "general",

  execute: async (ctx) => {
    const { sock, jid, msg } = ctx;

    // Replace this with your real WhatsApp Channel link
    const channelLink = "https://whatsapp.com/channel/0029Vb9AwScF6sn47ClubG1Z";

    try {
      const content = {
        text:
          "👑 *RED TECH AI*\n\n" +
          "Powered by RED TECH AI 👑\n\n" +
          "Follow our official channel for updates!",
        footer: "RED TECH AI",
        templateButtons: [
          {
            index: 1,
            urlButton: {
              displayText: "View channel",
              url: channelLink
            }
          }
        ]
      };

      await sock.sendMessage(jid, content, { quoted: msg });
    } catch (error) {
      console.error("[CHANNEL BUTTON ERROR]", error);
      await sock.sendMessage(
        jid,
        { text: "❌ Could not send the channel button. Please try again." },
        { quoted: msg }
      );
    }
  }
};
      
