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
        isBanNotice
            ? `You have been banned from **${guildName}**.`
            : `A moderation action was taken against you in **${guildName}**.`,
        `Action: **${action}**`,
        durationMinutes ? `Duration: **${durationMinutes} minute(s)**` : null,
        `Reason: ${reason}`,
        isBanNotice ? 'To appeal, reply directly to this message with your explanation.' : null
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

function createBanActionEmbed({ user, moderator, reason, dmSent }) {
    return new EmbedBuilder()
        .setTitle('User Banned')
        .setColor(0xED4245)
        .addFields(
            { name: 'User', value: `${user.tag || user.username} (${user.id})`, inline: true },
            { name: 'Moderator', value: moderator.tag || moderator.username, inline: true },
            { name: 'DM notice', value: dmSent ? 'Sent' : 'Could not be delivered', inline: true },
            { name: 'Reason', value: reason }
        )
        .setTimestamp();
}

module.exports = { createBanActionEmbed, notifyModerationTarget };
