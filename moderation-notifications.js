const { EmbedBuilder } = require('discord.js');

async function notifyModerationTarget({
    user,
    guildId,
    guildName,
    action,
    reason,
    durationMinutes,
    logEvent,
    reportError
}) {
    const description = [
        `A moderation action was taken against you in **${guildName}**.`,
        `Action: **${action}**`,
        durationMinutes ? `Duration: **${durationMinutes} minute(s)**` : null,
        `Reason: ${reason}`
    ].filter(Boolean).join('\n');

    try {
        await user.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xED4245)
                    .setTitle('Moderation notice')
                    .setDescription(description)
                    .setTimestamp()
            ],
            allowedMentions: { parse: [] }
        });
        logEvent('moderation_dm_sent', {
            guildId,
            targetId: user.id,
            action
        });
        return true;
    } catch (error) {
        reportError(`Unable to DM ${action} notice to user ${user.id}`, error);
        logEvent('moderation_dm_failed', {
            targetId: user.id,
            action,
            error: error.message
        });
        return false;
    }
}

module.exports = { notifyModerationTarget };
