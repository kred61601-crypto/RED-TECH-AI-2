// lib/userModel.js
// KING RED AI — basic XP model
// Replace with your persistent database model for production.

const users = new Map();

function addXP(sender, amount = 1) {
    if (!sender) return null;

    const current = users.get(sender) || {
        xp: 0,
        level: 1
    };

    current.xp += Number(amount) || 0;
    current.level = Math.floor(current.xp / 100) + 1;

    users.set(sender, current);
    return { ...current };
}

function getUser(sender) {
    if (!sender) return null;
    const user = users.get(sender);
    return user ? { ...user } : {
        xp: 0,
        level: 1
    };
}

module.exports = { addXP, getUser };
