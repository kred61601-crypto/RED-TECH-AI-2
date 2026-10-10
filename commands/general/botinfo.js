const os = require("os");

module.exports = {
    name: "botinfo",
    aliases: ["info", "system"],
    description: "Check detailed bot info.",
    category: "general",
    execute: async ({ sock, jid }) => {
        const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        
        const info = `🤖 *𝐑𝐄𝐃𝐓𝐄𝐂𝐇  BOT SYSTEM INFO*\n\n` +
                     `✨ *Version:* \`2.5.0 (Moderation)\`\n` +
                     `👨‍💻 *Developer:* \`𝐑𝐄𝐃𝐓𝐄𝐂𝐇 Studios\`\n` +
                     `📂 *GitHub:* https://github.com/njogu26713-commits/firebox-bot\n` +
                     `💬 *Support:* https://whatsapp.com/channel/0029Vb9AwScF6sn47ClubG1Z\n\n` +
                     `💻 *Platform:* \`${os.platform()}\`\n` +
                     `📟 *Memory:* \`${memory}MB / ${totalMem}GB\`\n` +
                     `🔋 *Node:* \`${process.version}\`\n\n` +
                     `_𝐑𝐄𝐃𝐓𝐄𝐂𝐇 Bot is a high-performance bot designed for professional group management._`;
        
        await sock.sendMessage(jid, { text: info });
    }
};
