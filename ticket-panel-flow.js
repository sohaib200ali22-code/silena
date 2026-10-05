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

const MAX_PANEL_TITLE_LENGTH = 256;
const MAX_PANEL_DESCRIPTION_LENGTH = 4000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PANEL_TITLE = 'Need help?';
const DEFAULT_PANEL_DESCRIPTION = 'Press **Create Ticket** to open a private support channel. Only you, support staff, and Silena can see it.';

function createTicketPanelFlow({ client, config, createSilenaEmbed, logEvent, reportError }) {
    const previews = new Map();

    function clearPreview(id) {
        const preview = previews.get(id);
        if (!preview) return;
        clearTimeout(preview.expiryTimer);
        previews.delete(id);
    }

    function createModal(id, values = {}) {
        const title = new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Panel title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(MAX_PANEL_TITLE_LENGTH);
        const description = new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Panel message')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(MAX_PANEL_DESCRIPTION_LENGTH);
        if (values.title) title.setValue(values.title);
        if (values.description) description.setValue(values.description);

        return new ModalBuilder()
            .setCustomId(`ticket-panel:modal:${id}`)
            .setTitle('Create ticket panel')
            .addComponents(
                new ActionRowBuilder().addComponents(title),
                new ActionRowBuilder().addComponents(description)
            );
    }

    function createButtons(id, revision) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket-panel:send:${id}:${revision}`)
                .setLabel('Send')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`ticket-panel:edit:${id}:${revision}`)
                .setLabel('Edit')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`ticket-panel:cancel:${id}:${revision}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
    }

    function isAuthorized(interaction, preview) {
        return interaction.inGuild() &&
            interaction.guildId === config.guildId &&
            interaction.user.id === config.ownerId &&
            preview.ownerId === interaction.user.id &&
            preview.guildId === interaction.guildId;
    }

    function destinationError(channel) {
        if (
            !channel ||
            channel.guildId !== config.guildId ||
            channel.type !== ChannelType.GuildText ||
            typeof channel.send !== 'function'
        ) {
            return 'The ticket panel destination must be a text channel in the configured server.';
        }
        if (!channel.permissionsFor(client.user)?.has([
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks
        ])) {
            return 'Silena needs Send Messages and Embed Links in the ticket panel channel.';
        }
        return null;
    }

    async function deny(interaction, message) {
        return interaction.reply({ content: message, ephemeral: true });
    }

    async function start(interaction) {
        const channel = interaction.channel;
        const error = destinationError(channel);
        if (error) return deny(interaction, error);

        const id = randomUUID();
        const expiryTimer = setTimeout(() => previews.delete(id), PREVIEW_TTL_MS);
        expiryTimer.unref?.();
        previews.set(id, {
            ownerId: interaction.user.id,
            guildId: interaction.guildId,
            channelId: channel.id,
            title: DEFAULT_PANEL_TITLE,
            description: DEFAULT_PANEL_DESCRIPTION,
            revision: 0,
            status: 'editing',
            expiryTimer
        });
        return interaction.showModal(createModal(id, previews.get(id)));
    }

    async function handleModal(interaction) {
        const match = /^ticket-panel:modal:([0-9a-f-]{36})$/.exec(interaction.customId);
        if (!match) return;
        const id = match[1];
        const preview = previews.get(id);
        if (!preview) return deny(interaction, 'This ticket panel preview expired. Run `/ticket-panel` again.');
        if (!isAuthorized(interaction, preview)) {
            return deny(interaction, 'Only the configured bot owner can edit this ticket panel.');
        }
        if (preview.status !== 'editing' && preview.status !== 'ready') {
            return deny(interaction, 'This ticket panel form is no longer active.');
        }

        const title = interaction.fields.getTextInputValue('title').trim();
        const description = interaction.fields.getTextInputValue('description').trim();
        if (
            !title ||
            title.length > MAX_PANEL_TITLE_LENGTH ||
            !description ||
            description.length > MAX_PANEL_DESCRIPTION_LENGTH
        ) {
            return deny(interaction, `Enter a non-blank title (up to ${MAX_PANEL_TITLE_LENGTH} characters) and message (up to ${MAX_PANEL_DESCRIPTION_LENGTH} characters).`);
        }

        preview.title = title;
        preview.description = description;
        preview.revision += 1;
        preview.status = 'ready';
        return interaction.reply({
            content: `Ticket panel preview for <#${preview.channelId}>. Nothing is posted until you choose **Send**.`,
            embeds: [createSilenaEmbed(title, description)],
            components: [createButtons(id, preview.revision)],
            allowedMentions: { parse: [] },
            ephemeral: true
        });
    }

    async function handleButton(interaction) {
        const match = /^ticket-panel:(send|edit|cancel):([0-9a-f-]{36}):(\d+)$/.exec(interaction.customId);
        if (!match) return;
        const [, action, id, revisionText] = match;
        const preview = previews.get(id);
        if (!preview) return deny(interaction, 'This ticket panel preview expired. Run `/ticket-panel` again.');
        if (!isAuthorized(interaction, preview)) {
            return deny(interaction, 'Only the configured bot owner can use this ticket panel preview.');
        }
        if (Number(revisionText) !== preview.revision) {
            return deny(interaction, 'This preview was replaced by a newer edit. Use the latest preview controls.');
        }
        if (preview.status !== 'ready') {
            return deny(interaction, 'This ticket panel preview is not ready or is already being posted.');
        }

        if (action === 'edit') return interaction.showModal(createModal(id, preview));
        if (action === 'cancel') {
            clearPreview(id);
            return interaction.update({
                content: 'Ticket panel cancelled. Nothing was posted.',
                embeds: [],
                components: []
            });
        }

        preview.status = 'sending';
        let panel;
        try {
            const channel = await client.channels.fetch(preview.channelId);
            const error = destinationError(channel);
            if (error) throw new Error(error);
            const createTicketButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket:create')
                    .setLabel('Create Ticket')
                    .setStyle(ButtonStyle.Primary)
            );
            panel = await channel.send({
                embeds: [createSilenaEmbed(preview.title, preview.description)],
                components: [createTicketButton],
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            preview.status = 'ready';
            reportError('Unable to post ticket panel', error);
            return interaction.update({
                content: `Could not post ticket panel: ${error.message} You can edit, cancel, or try sending again.`,
                embeds: [createSilenaEmbed(preview.title, preview.description)],
                components: [createButtons(id, preview.revision)],
                allowedMentions: { parse: [] }
            });
        }

        clearPreview(id);
        logEvent('ticket_panel_posted', {
            guildId: preview.guildId,
            channelId: preview.channelId,
            messageId: panel.id,
            actorId: preview.ownerId,
            title: preview.title
        });
        try {
            return await interaction.update({
                content: `Ticket panel posted in <#${preview.channelId}>.`,
                embeds: [],
                components: []
            });
        } catch (error) {
            reportError('Ticket panel was posted, but its preview could not be updated', error);
        }
    }

    return { handleButton, handleModal, start };
}

module.exports = {
    DEFAULT_PANEL_DESCRIPTION,
    DEFAULT_PANEL_TITLE,
    MAX_PANEL_DESCRIPTION_LENGTH,
    MAX_PANEL_TITLE_LENGTH,
    createTicketPanelFlow
};
