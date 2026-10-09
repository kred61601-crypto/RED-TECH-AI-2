require("dotenv").config();

module.exports = {
    // Bot version
    version: "1.0.1",

    // Bot owners (Full JIDs or raw numbers)
    ownerNumbers: [
        ...(process.env.SUDO ? [process.env.SUDO.includes("@") ? process.env.SUDO.trim() : `${process.env.SUDO.trim()}@s.whatsapp.net`] : []),
        ...(process.env.OWNERS ? process.env.OWNERS.split(",").map(num => num.trim().includes("@") ? num.trim() : `${num.trim()}@s.whatsapp.net`) : []),
        "254100969922@s.whatsapp.net", // Default Fallback
    ],

    // Command prefixes the bot will respond to
    prefixes: ["."],

    // Baileys auth folder
    authFolder: "session",

    // Max IDs to track for duplicate prevention
    processedIdLimit: 500,

    // Admins (in addition to owner) — add numbers like "2547...@s.whatsapp.net"
    admins: [],

    // AI Configuration (Read from .env for security)
    openaiKey: (process.env.OPENAI_API_KEY || "").trim(),
    groqKey: (process.env.GROQ_API_KEY || "").trim(),

    REACT_EMOJIS: process.env.REACT_EMOJIS 
    ? process.env.REACT_EMOJIS.split(',').map(e => e.trim()) 
    : ["❤️", "🔥", "👍", "😍", "😂", "😮", "😎", "🥰", "👋", "🤝", "💯", "✨", "⭐", "🎉", "🤗", "😊", "🙌", "💪", "👏", "✅", "🎈", "🎊", "🏆", "⚡", "💫", "👌", "🤙", "💖", "💕", "💗", "👑", "💎", "🌟", "🎯", "🎨", "🎭", "🎪", "🎢", "🎡", "🎠"],
  OWNER_EMOJIS: process.env.OWNER_EMOJIS 
    ? process.env.OWNER_EMOJIS.split(',').map(e => e.trim()) 
    : ["👑", "💎", "⭐", "✨", "🔥", "💯", "✅", "🎉", "🤖", "⚡", "💫", "🌟", "🏆", "👾", "🚀", "💪", "🎯", "🔱", "♾️", "⚜️"],
    }
