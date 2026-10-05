const { PermissionFlagsBits } = require('discord.js');

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
    let lastGlobalPruneAt = 0;

    return {
        record(guildId, userId, message) {
            const key = `${guildId}:${userId}`;
            const timestamp = now();
            const cutoff = timestamp - windowMs;
            if (timestamp - lastGlobalPruneAt >= windowMs) {
                for (const [authorKey, entries] of messagesByAuthor) {
                    const activeEntries = entries.filter(entry => entry.timestamp > cutoff);
                    if (activeEntries.length) messagesByAuthor.set(authorKey, activeEntries);
                    else messagesByAuthor.delete(authorKey);
                }
                lastGlobalPruneAt = timestamp;
            }
            const recentMessages = (messagesByAuthor.get(key) || [])
                .filter(entry => entry.timestamp > cutoff);
            recentMessages.push({ timestamp, message });
            messagesByAuthor.set(key, recentMessages);
            if (recentMessages.length <= limit) return null;

            messagesByAuthor.delete(key);
            return {
                violation: 'spam',
                messages: recentMessages.map(entry => entry.message).filter(Boolean)
            };
        }
    };
}

async function enforceSpamBurst({
    messages,
    member,
    guild,
    user,
    timeoutMs = 60 * 60 * 1000,
    notifyModerationTarget,
    logEvent,
    reportError
}) {
    const reason = 'Silena Guard anti-spam: repeated messages';
    let timeoutApplied = false;
    let dmSent = false;
    let deletedMessages = 0;
    let failedDeletes = 0;

    if (
        member?.moderatable &&
        guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)
    ) {
        try {
            await member.timeout(timeoutMs, reason);
            timeoutApplied = true;
            dmSent = await notifyModerationTarget({
                user,
                guildId: guild.id,
                guildName: guild.name,
                action: 'automated anti-spam timeout',
                reason,
                durationMinutes: timeoutMs / 60_000,
                logEvent,
                reportError
            });
            logEvent('automod_spam_timeout', {
                guildId: guild.id,
                userId: user.id,
                durationMinutes: timeoutMs / 60_000,
                dmSent,
                reason
            });
        } catch (error) {
            reportError(`Silena could not timeout spammer ${user.id}`, error);
        }
    } else {
        reportError(
            `Silena cannot timeout spammer ${user.id}`,
            new Error('Missing Moderate Members permission or target is not moderatable.')
        );
    }

    for (const message of messages) {
        try {
            await message.delete(reason);
            deletedMessages += 1;
        } catch (error) {
            failedDeletes += 1;
            reportError(`Silena could not delete spam message ${message.id}`, error);
        }
    }

    return { timeoutApplied, dmSent, deletedMessages, failedDeletes };
}

module.exports = { createSpamTracker, enforceSpamBurst, getAutomodViolation };
