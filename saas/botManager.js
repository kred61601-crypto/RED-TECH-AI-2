/**
 * BotManager — manages one BotInstance per SaaS user.
 * Instances are created on demand and kept alive in memory.
 */
const BotInstance = require("./botInstance");

class BotManager {
    constructor() {
        /** @type {Map<string, BotInstance>} */
        this.instances = new Map();
    }

    get(userId) {
        if (!this.instances.has(userId)) {
            this.instances.set(userId, new BotInstance(userId));
        }

        return this.instances.get(userId);
    }

    async start(userId) {
        const instance = this.get(userId);

        if (instance.status === "offline" && !instance.isReconnecting) {
            await instance.start();
        }

        return instance;
    }

    async restorePersisted() {
        const tokenRegistry = require("./tokenRegistry");
        const botIds = await tokenRegistry.listActiveBotIds();

        for (const botId of botIds) {
            try {
                await this.start(botId);
                console.log(`[${botId}] Persistent bot restore started.`);
            } catch (error) {
                console.error(
                    `[${botId}] Persistent bot restore failed:`,
                    error.message
                );
            }
        }
    }

    stop(userId) {
        const instance = this.instances.get(userId);

        if (instance) {
            instance.stop();
            this.instances.delete(userId);
        }
    }

    async resetForPairing(userId) {
        this.stop(userId);

        // Allow WhatsApp time to observe the old device disconnect.
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Updated from firebox to redtech.
        const { clearDatabaseAuthState } = require("../redtech/dbAuth");

        await clearDatabaseAuthState(`saas_${userId}`);
    }

    getStatus(userId) {
        const instance = this.instances.get(userId);

        if (!instance) {
            return {
                status: "offline",
                latestQr: null,
                myJid: null
            };
        }

        return {
            status: instance.status,
            latestQr: instance.latestQr,
            myJid: instance.myJid
        };
    }

    has(userId) {
        return this.instances.has(userId);
    }

    all() {
        return Array.from(this.instances.entries()).map(([userId, inst]) => ({
            userId,
            status: inst.status,
            myJid: inst.myJid
        }));
    }
}

// Singleton
module.exports = new BotManager();
