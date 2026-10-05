const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ModalBuilder,
    PermissionFlagsBits,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { randomUUID } = require('node:crypto');

const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 4000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;

function createAnnouncementFlow({ client, config, createSilenaEmbed, logEvent, reportError }) {
    const previews = new Map();

    function clearPreview(id) {
        const preview = previews.get(id);
        if (!preview) return;
        clearTimeout(preview.expiryTimer);
        previews.delete(id);
    }

    function createModal(id, values = {}) {
        const titleInput = new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Announcement title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(MAX_TITLE_LENGTH);
        const messageInput = new TextInputBuilder()
            .setCustomId('message')
            .setLabel('Announcement message')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(MAX_BODY_LENGTH);

        if (values.title) titleInput.setValue(values.title);
        if (values.message) messageInput.setValue(values.message);

        return new ModalBuilder()
            .setCustomId(`announcement:modal:${id}`)
            .setTitle('Create announcement')
            .addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(messageInput)
            );
    }

    function createButtons(id, revision) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`announcement:send:${id}:${revision}`)
                .setLabel('Send')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`announcement:edit:${id}:${revision}`)
                .setLabel('Edit')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`announcement:cancel:${id}:${revision}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    function isAuthorized(interaction) {
        return interaction.inGuild() &&
            interaction.guildId === config.guildId &&
            interaction.user.id === config.ownerId;
    }

    async function deny(interaction, message) {
        return interaction.reply({ content: message, ephemeral: true });
    }

    function validDestination(channel) {
        if (
            !channel ||
            channel.guildId !== config.guildId ||
            channel.type !== ChannelType.GuildText ||
            typeof channel.send !== 'function'
        ) {
            return 'Choose a text channel in the configured server.';
        }

        const permissions = channel.permissionsFor(client.user);
        if (!permissions?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            return 'Silena needs Send Messages and Embed Links in the announcement channel.';
        }
        return null;
    }

    async function start(interaction) {
        const destination = interaction.options.getChannel('channel') || interaction.channel;
        const destinationError = validDestination(destination);
        if (destinationError) return deny(interaction, destinationError);

        const id = randomUUID();
        const expiryTimer = setTimeout(() => previews.delete(id), PREVIEW_TTL_MS);
        expiryTimer.unref?.();
        previews.set(id, {
            ownerId: interaction.user.id,
            guildId: interaction.guildId,
            destinationId: destination.id,
            status: 'editing',
            revision: 0,
            expiryTimer
        });
        return interaction.showModal(createModal(id));
    }

    async function handleModal(interaction) {
        const match = /^announcement:modal:([0-9a-f-]{36})$/.exec(interaction.customId);
        if (!match) return;
        const id = match[1];
        const preview = previews.get(id);
        if (!preview) return deny(interaction, 'This announcement preview expired. Run `/announcement` again.');
        if (!isAuthorized(interaction) || preview.ownerId !== interaction.user.id || preview.guildId !== interaction.guildId) {
            return deny(interaction, 'Only the configured bot owner can edit this announcement.');
        }
        if (preview.status !== 'editing' && preview.status !== 'ready') {
            return deny(interaction, 'This announcement modal is no longer active.');
        }

        const title = interaction.fields.getTextInputValue('title').trim();
        const message = interaction.fields.getTextInputValue('message').trim();
        if (
            !title ||
            title.length > MAX_TITLE_LENGTH ||
            !message ||
            message.length > MAX_BODY_LENGTH
        ) {
            return deny(interaction, `Enter a non-blank title (up to ${MAX_TITLE_LENGTH} characters) and message (up to ${MAX_BODY_LENGTH} characters).`);
        }

        preview.title = title;
        preview.message = message;
        preview.status = 'ready';
        preview.revision += 1;
        return interaction.reply({
            content: `Preview for <#${preview.destinationId}>. Nothing is public until you choose **Send**.`,
            embeds: [createSilenaEmbed(title, message)],
            components: [createButtons(id, preview.revision)],
            allowedMentions: { parse: [] },
            ephemeral: true
        });
    }

    async function handleButton(interaction) {
        const match = /^announcement:(send|edit|cancel):([0-9a-f-]{36}):(\d+)$/.exec(interaction.customId);
        if (!match) return;
        const [, action, id, revisionText] = match;
        const preview = previews.get(id);
        if (!preview) return deny(interaction, 'This announcement preview expired. Run `/announcement` again.');
        if (!isAuthorized(interaction) || preview.ownerId !== interaction.user.id || preview.guildId !== interaction.guildId) {
            return deny(interaction, 'Only the configured bot owner can use this announcement preview.');
        }
        if (Number(revisionText) !== preview.revision) {
            return deny(interaction, 'This preview has been replaced by a newer edit. Use the latest preview controls.');
        }
        if (preview.status !== 'ready') {
            return deny(interaction, 'This announcement preview is not ready or is already being sent.');
        }

        if (action === 'edit') {
            return interaction.showModal(createModal(id, preview));
        }
        if (action === 'cancel') {
            clearPreview(id);
            return interaction.update({
                content: 'Announcement cancelled. Nothing was published.',
                embeds: [],
                components: []
            });
        }

        preview.status = 'sending';
        let announcement;
        try {
            const destination = await client.channels.fetch(preview.destinationId);
            const destinationError = validDestination(destination);
            if (destinationError) throw new Error(destinationError);
            announcement = await destination.send({
                embeds: [createSilenaEmbed(preview.title, preview.message)],
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            preview.status = 'ready';
            reportError('Unable to post announcement', error);
            return interaction.update({
                content: `Could not post announcement: ${error.message} You can edit, cancel, or try sending again.`,
                embeds: [createSilenaEmbed(preview.title, preview.message)],
                components: [createButtons(id, preview.revision)],
                allowedMentions: { parse: [] }
            });
        }

        clearPreview(id);
        logEvent('announcement_posted', {
            guildId: preview.guildId,
            channelId: preview.destinationId,
            messageId: announcement.id,
            actorId: preview.ownerId,
            title: preview.title
        });
        try {
            return await interaction.update({
                content: `Announcement posted in <#${preview.destinationId}>.`,
                embeds: [],
                components: []
            });
        } catch (error) {
            reportError('Announcement was published, but its preview could not be updated', error);
        }
    }

    return { handleButton, handleModal, start };
}

module.exports = {
    MAX_BODY_LENGTH,
    MAX_TITLE_LENGTH,
    createAnnouncementFlow
};
