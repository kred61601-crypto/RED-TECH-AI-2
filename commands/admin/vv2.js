// commands/admin/vv2.js

const store = require('../../redtech/jsonStore');

module.exports = {
    name: 'vv2',
    aliases: ['viewoncev2', 'vv'],
    category: 'admin',
    description: 'Enable or disable the VV2 emoji-reply link trigger',
    usage: '.vv2 on/off/status',
    ownerOnly: true,
    cooldown: 2000,

    async execute({ sock, jid, args }) {
        const action = String(args[0] || 'status').toLowerCase();

        if (action === 'on') {
            store.set('vv2_enabled', true);

            return sock.sendMessage(jid, {
                text:
                    '✅ *VV2 enabled*\n\n' +
                    'Reply to a message containing a supported social-media ' +
                    'link with a supported emoji to send that link to the ' +
                    'linked bot account’s private chat.\n\n' +
                    'WhatsApp View Once protections will not be bypassed.'
            });
        }

        if (action === 'off') {
            store.set('vv2_enabled', false);

            return sock.sendMessage(jid, {
                text: '🛑 *VV2 disabled.* Emoji replies will no longer trigger VV2.'
            });
        }

        if (action === 'status') {
            const enabled = store.get('vv2_enabled', false) === true;

            return sock.sendMessage(jid, {
                text: `📊 *VV2 Status:* ${enabled ? 'ON ✅' : 'OFF 🛑'}`
            });
        }

        return sock.sendMessage(jid, {
            text: 'Usage: .vv2 on, .vv2 off, or .vv2 status'
        });
    }
};
