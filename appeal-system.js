const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');

const BAN_NOTICE_MARKER = 'silena:ban-notice';
const APPEAL_BUTTON_PATTERN = /^appeal:(approve|reject):(\d{17,20}):(\d{17,20})$/;
const FIELD_LIMIT = 1024;

function shorten(value, limit = FIELD_LIMIT) {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 20)}\n[truncated; see attached appeal text]`;
}

function createReviewRow(userId, appealMessageId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`appeal:approve:${userId}:${appealMessageId}`)
            .setLabel('Approve and unban')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`appeal:reject:${userId}:${appealMessageId}`)
            .setLabel('Reject appeal')
            .setStyle(ButtonStyle.Danger)
    );
}

function createAppealService({ client, config, logEvent, reportError }) {
    const submittedBanNotices = new Set();
    const submittingBanNotices = new Set();
    const appealsInProgress = new Set();

    function isBanNotice(message) {
        return Boolean(
            message?.author?.id === client.user?.id &&
            message.embeds?.some(embed => embed.footer?.text === BAN_NOTICE_MARKER)
        );
    }

    async function findLogsChannel() {
        const channel = await client.channels.fetch(config.logsChannelId);
        if (!channel || channel.guildId !== config.guildId || !channel.isTextBased()) {
            throw new Error('LOGS_CHANNEL_ID must point to a text channel in the configured server.');
        }
        if (!channel.permissionsFor(client.user)?.has([
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks
        ])) {
            throw new Error('Silena needs Send Messages and Embed Links in LOGS_CHANNEL_ID to receive appeals.');
        }
        return channel;
    }

    async function handleMessage(message) {
        if (
            message.guildId ||
            message.author?.bot ||
            !message.reference?.messageId ||
            typeof message.fetchReference !== 'function'
        ) {
            return false;
        }

        let referencedMessage;
        try {
            referencedMessage = await message.fetchReference();
        } catch (error) {
            if (error.code !== 10008) {
                reportError(`Unable to inspect DM reply ${message.id} for an appeal`, error);
            }
            return false;
        }
        if (!isBanNotice(referencedMessage)) return false;

        const banNoticeId = referencedMessage.id;
        if (submittedBanNotices.has(banNoticeId) || submittingBanNotices.has(banNoticeId)) {
            await message.reply({
                content: 'An appeal for this ban notice has already been submitted. The server owner will review it.',
                allowedMentions: { parse: [] }
            });
            return true;
        }

        const content = message.content?.trim() || '';
        const attachmentUrls = [...(message.attachments?.values?.() || [])]
            .map(attachment => attachment.url);
        if (!content && attachmentUrls.length === 0) {
            await message.reply({
                content: 'Please include an explanation or an attachment with your appeal.',
                allowedMentions: { parse: [] }
            });
            return true;
        }

        submittingBanNotices.add(banNoticeId);
        try {
            const logsChannel = await findLogsChannel();
            const appealText = [
                `Appeal from ${message.author.tag || message.author.username} (${message.author.id})`,
                `Ban notice message ID: ${banNoticeId}`,
                `Appeal message ID: ${message.id}`,
                '',
                'Appeal:',
                content || '[no text provided]',
                '',
                'Attachments:',
                ...(attachmentUrls.length ? attachmentUrls : ['[none]'])
            ].join('\n');
            const embed = new EmbedBuilder()
                .setTitle('Ban appeal')
                .setColor(0x5865F2)
                .setDescription('A banned user replied to their Silena ban notice. Review the explanation, then choose an action.')
                .addFields(
                    { name: 'User', value: `${message.author.tag || message.author.username} (${message.author.id})` },
                    { name: 'User ID', value: message.author.id, inline: true },
                    { name: 'Appeal message', value: content ? shorten(content) : '[text not provided]', inline: true },
                    { name: 'Attachments', value: attachmentUrls.length ? shorten(attachmentUrls.join('\n')) : 'None' }
                )
                .setFooter({ text: `Appeal message ID: ${message.id} • Ban notice ID: ${banNoticeId}` })
                .setTimestamp();
            const files = content.length > FIELD_LIMIT
                ? [{ attachment: Buffer.from(appealText, 'utf8'), name: `appeal-${message.id}.txt` }]
                : [];
            if (files.length && !logsChannel.permissionsFor(client.user)?.has(PermissionFlagsBits.AttachFiles)) {
                throw new Error('Silena needs Attach Files in LOGS_CHANNEL_ID to preserve long appeal messages.');
            }

            await logsChannel.send({
                embeds: [embed],
                components: [createReviewRow(message.author.id, message.id)],
                ...(files.length ? { files } : {}),
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            reportError(`Unable to forward ban appeal from user ${message.author.id}`, error);
            await message.reply({
                content: 'Silena could not deliver your appeal to the staff team. Please try again later.',
                allowedMentions: { parse: [] }
            });
            return false;
        } finally {
            submittingBanNotices.delete(banNoticeId);
        }

        submittedBanNotices.add(banNoticeId);
        logEvent('ban_appeal_submitted', {
            guildId: config.guildId,
            userId: message.author.id,
            appealMessageId: message.id,
            banNoticeId
        });
        try {
            await message.reply({
                content: 'Your appeal was sent to the server owner for review. You will receive a DM when it is decided.',
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            reportError(`Appeal from user ${message.author.id} was delivered, but its DM receipt could not be sent`, error);
        }
        return true;
    }

    function verifyReviewMessage(interaction, userId, appealMessageId) {
        if (
            interaction.guildId !== config.guildId ||
            interaction.channelId !== config.logsChannelId ||
            interaction.message?.author?.id !== client.user?.id
        ) {
            return false;
        }
        const embed = interaction.message.embeds?.[0];
        const fields = embed?.fields || [];
        return Boolean(
            embed?.title === 'Ban appeal' &&
            embed.footer?.text?.includes(`Appeal message ID: ${appealMessageId}`) &&
            fields.some(field => field.name === 'User ID' && field.value === userId)
        );
    }

    async function notifyUser(userId, content, action) {
        try {
            const user = await client.users.fetch(userId);
            await user.send({ content, allowedMentions: { parse: [] } });
            logEvent('ban_appeal_user_notified', {
                guildId: config.guildId,
                userId,
                action
            });
            return true;
        } catch (error) {
            reportError(`Unable to DM appeal decision to user ${userId}`, error);
            logEvent('ban_appeal_notification_failed', {
                guildId: config.guildId,
                userId,
                action,
                error: error.message
            });
            return false;
        }
    }

    async function handleButton(interaction) {
        const parsed = APPEAL_BUTTON_PATTERN.exec(interaction.customId);
        if (!parsed) return false;
        const [, decision, userId, appealMessageId] = parsed;

        if (interaction.user.id !== config.ownerId) {
            await interaction.reply({
                content: 'Only the configured bot owner can decide ban appeals.',
                ephemeral: true
            });
            return true;
        }
        if (!verifyReviewMessage(interaction, userId, appealMessageId)) {
            await interaction.reply({
                content: 'This appeal control is not valid in this channel or its appeal details do not match.',
                ephemeral: true
            });
            return true;
        }
        if (decision === 'approve' && (
            !interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers) ||
            !interaction.appPermissions?.has(PermissionFlagsBits.BanMembers)
        )) {
            await interaction.reply({
                content: 'You and Silena both need Ban Members permission to approve an appeal and unban the user.',
                ephemeral: true
            });
            return true;
        }

        if (appealsInProgress.has(appealMessageId)) {
            await interaction.reply({ content: 'This appeal is already being processed.', ephemeral: true });
            return true;
        }
        appealsInProgress.add(appealMessageId);
        try {
            if (decision === 'approve') {
                await interaction.guild.bans.remove(userId, `Ban appeal ${appealMessageId} approved by configured bot owner`);
                const dmSent = await notifyUser(
                    userId,
                    `Your ban appeal in **${interaction.guild.name}** was approved. The ban has been removed; you may rejoin the server.`,
                    decision
                );
                logEvent('ban_appeal_approved', {
                    guildId: config.guildId,
                    userId,
                    appealMessageId,
                    reviewerId: interaction.user.id,
                    dmSent
                });
            } else {
                const dmSent = await notifyUser(
                    userId,
                    `Your ban appeal in **${interaction.guild.name}** was reviewed and declined. The ban remains in place.`,
                    decision
                );
                logEvent('ban_appeal_rejected', {
                    guildId: config.guildId,
                    userId,
                    appealMessageId,
                    reviewerId: interaction.user.id,
                    dmSent
                });
            }

            const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                .setColor(decision === 'approve' ? 0x57F287 : 0xED4245)
                .setFooter({
                    text: `Appeal ${decision === 'approve' ? 'approved' : 'rejected'} by ${interaction.user.tag || interaction.user.username}`
                });
            await interaction.update({ embeds: [updatedEmbed], components: [] });
            return true;
        } finally {
            appealsInProgress.delete(appealMessageId);
        }
    }

    return { handleButton, handleMessage };
}

module.exports = {
    BAN_NOTICE_MARKER,
    createAppealService
};
