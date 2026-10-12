module.exports = {
    name: "ping",
    aliases: ["p"],
    description: "Check bot response speed",
    category: "general",

    async execute({ sock, jid, msg }) {
        const start = Date.now();

        try {
            const sent = await sock.sendMessage(jid, {
                text: "⚡ Testing REDTECH-AI speed..."
            }, { quoted: msg });

            const latency = Date.now() - start;

            await sock.sendMessage(jid, {
                text:
                    "╭━━━〔 ⚡ REDTECH-AI PONG 〕━━━╮\n" +
                    `┃ 🚀 Response: ${latency} ms\n` +
                    `┃ 🟢 Status: ONLINE\n` +
                    "┃ 👑 Powered by Denzel\n" +
                    "╰━━━━━━━━━━━━━━━━━━━━╯",
                edit: sent.key
            });
        } catch (error) {
            console.error("[PING]", error);
            await sock.sendMessage(jid, {
                text: "⚠️ Ping failed. Please try again."
            });
        }
    }
};
