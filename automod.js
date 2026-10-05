const INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|discord\.me|discord\.io|discord\.li)\/[a-z0-9-]+/i;
const LINK_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

function getAutomodViolation(content, options) {
    if (options.blockInvites && INVITE_PATTERN.test(content)) return 'invite-link';
    if (options.blockLinks && LINK_PATTERN.test(content)) return 'link';
    const mentionCount = (content.match(/<@!?\d+>|<@&\d+>/g) || []).length;
    if (
        content.includes('@everyone') ||
        content.includes('@here') ||
        (options.mentionLimit >= 0 && mentionCount > options.mentionLimit)
    ) {
        return 'mass-mention';
    }
    return null;
}

function createSpamTracker({ limit, windowMs, now = Date.now }) {
    const messagesByAuthor = new Map();

    return {
        record(guildId, userId) {
            const key = `${guildId}:${userId}`;
            const timestamp = now();
            const cutoff = timestamp - windowMs;
            const recentMessages = (messagesByAuthor.get(key) || []).filter(timestamp => timestamp > cutoff);
            recentMessages.push(timestamp);
            messagesByAuthor.set(key, recentMessages);
            if (recentMessages.length <= limit) return null;

            messagesByAuthor.delete(key);
            return 'spam';
        }
    };
}

module.exports = { createSpamTracker, getAutomodViolation };
