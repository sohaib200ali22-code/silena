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
    const isBanNotice = action === 'ban';
    const description = [
        `A moderation action was taken against you in **${guildName}**.`,
        `Action: **${action}**`,
        durationMinutes ? `Duration: **${durationMinutes} minute(s)**` : null,
        `Reason: ${reason}`,
        isBanNotice ? 'If you want to appeal, reply to this message with your explanation.' : null
    ].filter(Boolean).join('\n');

    try {
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('Moderation notice')
            .setDescription(description)
            .setTimestamp();
        if (isBanNotice) embed.setFooter({ text: 'silena:ban-notice' });

        await user.send({
            embeds: [embed],
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
