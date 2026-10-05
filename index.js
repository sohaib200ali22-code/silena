require('dotenv').config();

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    PermissionFlagsBits
} = require('discord.js');
const { randomUUID } = require('node:crypto');
const { readConfig } = require('./config');
const { createSpamTracker, getAutomodViolation } = require('./automod');
const { createHealthServer } = require('./health-server');
const { registerGuildCommands } = require('./register-commands');
const { setChannelLocked } = require('./channel-lock');
const { deleteUserMessages, scanRecentMessages } = require('./purge-user-messages');
const { createAnnouncementFlow } = require('./announcement-flow');
const { createTicketPanelFlow } = require('./ticket-panel-flow');
const { notifyModerationTarget } = require('./moderation-notifications');
const { createTicketReminderService } = require('./ticket-reminders');
const {
    canCloseTicket,
    closePrivateTicket,
    createPrivateTicket,
    findOpenTicket,
    parseTicketTopic
} = require('./ticket-system');

const config = readConfig(process.env);
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
const spamTracker = createSpamTracker({
    limit: config.spamMaxMessages,
    windowMs: config.spamWindowSeconds * 1000
});

const commandPermissions = {
    clear: PermissionFlagsBits.ManageMessages,
    lock: PermissionFlagsBits.ManageChannels,
    unlock: PermissionFlagsBits.ManageChannels,
    slowmode: PermissionFlagsBits.ManageChannels,
    'ticket-panel': PermissionFlagsBits.ManageGuild,
    announcement: PermissionFlagsBits.ManageGuild,
    serverinfo: PermissionFlagsBits.ManageGuild,
    userinfo: PermissionFlagsBits.ManageGuild,
    timeout: PermissionFlagsBits.ModerateMembers,
    warn: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers
};

const botCommandPermissions = {
    clear: PermissionFlagsBits.ManageMessages,
    lock: PermissionFlagsBits.ManageChannels,
    unlock: PermissionFlagsBits.ManageChannels,
    slowmode: PermissionFlagsBits.ManageChannels,
    'ticket-panel': PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks,
    timeout: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers
};
const pendingUserPurges = new Map();
const openingTickets = new Set();
const closingTickets = new Set();
const announcementFlow = createAnnouncementFlow({
    client,
    config,
    createSilenaEmbed,
    logEvent,
    reportError
});
const ticketPanelFlow = createTicketPanelFlow({
    client,
    config,
    createSilenaEmbed,
    logEvent,
    reportError
});
const ticketReminders = createTicketReminderService({
    client,
    guildId: config.guildId,
    staffRoleId: config.staffRoleId,
    ownerId: config.ownerId,
    logEvent,
    reportError
});

function logEvent(type, details) {
    console.info(JSON.stringify({ type, at: new Date().toISOString(), ...details }));
}

function reportError(context, error) {
    console.error(`${context}:`, error);
}

function clearUserPurgeSession(sessionId) {
    const session = pendingUserPurges.get(sessionId);
    if (!session) return;
    clearTimeout(session.expiryTimer);
    pendingUserPurges.delete(sessionId);
}

async function prepareUserPurge(interaction, targetUser, maxDeletes, reason) {
    const channel = interaction.channel;
    if (!channel?.messages?.fetch || !channel.bulkDelete) {
        return interaction.reply({ content: 'This command requires a channel with message history and bulk-delete support.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const messages = await scanRecentMessages(channel);
        const matching = messages.filter(message => message.author.id === targetUser.id).length;
        if (matching === 0) {
            logEvent('user_message_purge_no_matches', {
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                actorId: interaction.user.id,
                targetId: targetUser.id,
                scanned: messages.length
            });
            return interaction.editReply(`Scanned ${messages.length} recent messages; none were from ${targetUser.tag}.`);
        }

        const sessionId = randomUUID();
        const expiryTimer = setTimeout(() => clearUserPurgeSession(sessionId), 2 * 60 * 1000);
        expiryTimer.unref?.();
        pendingUserPurges.set(sessionId, {
            messages,
            maxDeletes,
            reason,
            targetId: targetUser.id,
            targetName: targetUser.tag,
            ownerId: interaction.user.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            expiryTimer
        });
        logEvent('user_message_purge_confirmation_requested', {
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            scanned: messages.length,
            matching,
            maxDeletes
        });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`purge-user:${sessionId}:confirm`)
                .setLabel('Delete matches')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`purge-user:${sessionId}:cancel`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        return interaction.editReply({
            content: `Scanned ${messages.length} recent messages in this channel and found ${matching} from ${targetUser.tag}. Up to ${Math.min(matching, maxDeletes)} will be deleted; messages older than 14 days will be deleted individually. Continue?`,
            components: [buttons]
        });
    } catch (error) {
        reportError('Unable to prepare user message purge', error);
        return interaction.editReply('Could not scan this channel’s message history. No messages were deleted.');
    }
}

async function handleUserPurgeButton(interaction) {
    const match = /^purge-user:([0-9a-f-]+):(confirm|cancel)$/.exec(interaction.customId);
    if (!match) return false;

    const [, sessionId, action] = match;
    const session = pendingUserPurges.get(sessionId);
    if (!session) {
        await interaction.reply({ content: 'This confirmation has expired. Run /clear again if needed.', ephemeral: true });
        return true;
    }
    if (
        interaction.user.id !== session.ownerId ||
        interaction.user.id !== config.ownerId ||
        interaction.guildId !== session.guildId ||
        interaction.channelId !== session.channelId
    ) {
        await interaction.reply({ content: 'This confirmation is only available to the bot owner in the original channel.', ephemeral: true });
        return true;
    }
    if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
        !interaction.appPermissions?.has(PermissionFlagsBits.ManageMessages)
    ) {
        await interaction.reply({
            content: 'The required Manage Messages permission is no longer available; no messages were deleted.',
            ephemeral: true
        });
        clearUserPurgeSession(sessionId);
        return true;
    }

    clearUserPurgeSession(sessionId);
    await interaction.deferUpdate();
    if (action === 'cancel') {
        await interaction.editReply({ content: 'User message deletion cancelled. No messages were deleted.', components: [] });
        return true;
    }

    const channel = interaction.channel;
    const result = await deleteUserMessages(
        channel,
        session.messages,
        session.targetId,
        session.maxDeletes,
        { reason: session.reason }
    );
    logEvent('user_message_purge_completed', {
        guildId: session.guildId,
        channelId: session.channelId,
        actorId: session.ownerId,
        targetId: session.targetId,
        reason: session.reason,
        scanned: result.scanned,
        matching: result.matching,
        selected: result.selected,
        deleted: result.deleted,
        skipped: result.skipped,
        failed: result.failed
    });
    for (const failure of result.failures.slice(0, 10)) {
        reportError(
            `User message purge had ${failure.count} failure(s)${failure.messageId ? ` for message ${failure.messageId}` : ''}`,
            new Error(failure.message)
        );
    }

    await interaction.editReply({
        content: `User message purge for ${session.targetName} finished: scanned ${result.scanned}, matched ${result.matching}, deleted ${result.deleted}, skipped ${result.skipped} (not selected or not matching), failed ${result.failed}.`,
        components: []
    });
    return true;
}

async function leaveUnconfiguredGuild(guild) {
    if (guild.id === config.guildId) return;

    logEvent('unconfigured_guild_leave', { guildId: guild.id });
    try {
        await guild.leave();
    } catch (error) {
        reportError(`Unable to leave unconfigured guild ${guild.id}`, error);
    }
}

client.once(Events.ClientReady, async readyClient => {
    logEvent('ready', { bot: readyClient.user.tag, guildId: config.guildId });
    for (const guild of readyClient.guilds.cache.values()) {
        leaveUnconfiguredGuild(guild);
    }

    try {
        const result = await registerGuildCommands(config);
        logEvent('slash_commands_registered', {
            guildId: result.guildId,
            commandCount: result.count
        });
    } catch (error) {
        logEvent('slash_command_registration_failed', {
            guildId: config.guildId,
            error: error.message
        });
        reportError(`Failed to register slash commands for guild ${config.guildId}`, error);
    }

    try {
        const guild = await readyClient.guilds.fetch(config.guildId);
        logEvent('configured_guild_ready', { guildId: guild.id, name: guild.name });
        await ticketReminders.restoreOpenTickets(guild);
    } catch (error) {
        reportError(`Unable to access configured guild ${config.guildId}`, error);
    }
});

client.on(Events.GuildCreate, guild => {
    leaveUnconfiguredGuild(guild);
});

async function handleAutomod(message) {
    if (
        !message.guild ||
        message.guild.id !== config.guildId ||
        message.author.bot ||
        message.webhookId ||
        message.author.id === config.ownerId ||
        message.member?.permissions.has(PermissionFlagsBits.Administrator)
    ) {
        return;
    }

    const violation = getAutomodViolation(message.content, {
        blockInvites: config.blockInvites,
        blockLinks: config.blockLinks,
        mentionLimit: 5
    }) || spamTracker.record(message.guild.id, message.author.id);

    if (!violation) return;

    try {
        await message.delete();
    } catch (error) {
        reportError(`Automod could not delete message ${message.id}`, error);
        return;
    }

    logEvent('automod_action', {
        guildId: message.guild.id,
        channelId: message.channel.id,
        userId: message.author.id,
        messageId: message.id,
        rule: violation
    });

    try {
        const notice = await message.channel.send({
            content: `<@${message.author.id}> Your message was removed by Silena's ${violation} rule.`,
            allowedMentions: { users: [message.author.id] }
        });
        setTimeout(() => {
            notice.delete().catch(error => reportError('Unable to remove automod notice', error));
        }, 5000).unref?.();
    } catch (error) {
        reportError('Unable to send automod notice', error);
    }
}

client.on(Events.MessageCreate, message => {
    ticketReminders.handleMessage(message);
    handleAutomod(message).catch(error => reportError('Automod handler failed', error));
});

async function handleCommand(interaction) {
    try {
        return await dispatchCommand(interaction);
    } catch (error) {
        reportError(`Command ${interaction.commandName || 'unknown'} failed`, error);
        const response = {
            content: 'The command failed. Check the bot logs for details.',
            ephemeral: true
        };
        const sendResponse = interaction.deferred || interaction.replied
            ? interaction.followUp(response)
            : interaction.reply(response);
        await sendResponse.catch(replyError => {
            reportError('Unable to report command failure', replyError);
        });
    }
}

async function dispatchCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
        return interaction.reply({ content: 'This command is only available in the configured server.', ephemeral: true });
    }

    if (interaction.commandName === 'ticket') {
        return handleTicketOpen(interaction);
    }
    if (interaction.commandName === 'close') {
        return handleTicketClose(interaction);
    }

    if (interaction.user.id !== config.ownerId) {
        logEvent('command_denied', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            command: interaction.commandName,
            reason: 'not_bot_owner'
        });
        return interaction.reply({ content: 'Only the configured bot owner can use Silena commands.', ephemeral: true });
    }

    const requiredPermission = commandPermissions[interaction.commandName];
    if (!requiredPermission) {
        return interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }

    if (!interaction.memberPermissions?.has(requiredPermission)) {
        return interaction.reply({ content: 'You lack the server permission required for this command.', ephemeral: true });
    }

    const requiredBotPermission = botCommandPermissions[interaction.commandName];
    if (requiredBotPermission && !interaction.appPermissions.has(requiredBotPermission)) {
        return interaction.reply({ content: 'Silena lacks the server permission required for this command.', ephemeral: true });
    }

    const { commandName, options, guild } = interaction;
    const reason = options.getString('reason') || 'No reason provided';
    let targetUser;
    let targetMember;

    if (commandName === 'ticket-panel') {
        return ticketPanelFlow.start(interaction);
    }
    if (commandName === 'announcement') {
        return announcementFlow.start(interaction);
    }
    if (commandName === 'serverinfo') {
        const channels = guild.channels.cache;
        const embed = new EmbedBuilder()
            .setTitle(`${guild.name} server information`)
            .setColor(0x5865F2)
            .addFields(
                { name: 'Server ID', value: guild.id, inline: true },
                { name: 'Owner ID', value: guild.ownerId, inline: true },
                { name: 'Members', value: String(guild.memberCount), inline: true },
                { name: 'Channels', value: `${channels.filter(channel => channel.type === ChannelType.GuildText).size} text / ${channels.filter(channel => channel.type === ChannelType.GuildVoice).size} voice`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: true }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (commandName === 'userinfo') {
        const target = options.getUser('target', true);
        const member = await guild.members.fetch(target.id).catch(error => {
            if (error.code !== 10007) throw error;
            return null;
        });
        if (!member) {
            return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        }
        const roles = member.roles.cache
            .filter(role => role.id !== guild.id)
            .sort((left, right) => right.position - left.position)
            .map(role => `<@&${role.id}>`);
        const embed = new EmbedBuilder()
            .setTitle('Member information')
            .setColor(0x5865F2)
            .setThumbnail(target.displayAvatarURL())
            .addFields(
                { name: 'User', value: `${target.tag || target.username} (${target.id})` },
                { name: 'Account created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:F>`, inline: true },
                { name: 'Joined server', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : 'Unknown', inline: true },
                { name: 'Roles', value: roles.length ? roles.join(', ').slice(0, 1024) : 'None' }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    }

    if (commandName === 'lock' || commandName === 'unlock') {
        if (!interaction.channel) {
            return interaction.reply({ content: 'This command requires a channel.', ephemeral: true });
        }

        const locked = commandName === 'lock';
        await setChannelLocked(interaction.channel, locked, reason);
        logEvent('moderation_action', {
            guildId: guild.id,
            channelId: interaction.channelId,
            actorId: interaction.user.id,
            command: commandName,
            reason
        });

        return interaction.reply({
            content: locked
                ? 'This channel is locked for @everyone. Explicit member or role permissions may still allow sending messages.'
                : 'The @everyone send-message override was removed. This channel follows its category and server permissions again.',
            ephemeral: true
        });
    }
    if (commandName === 'slowmode') {
        const channel = interaction.channel;
        if (!channel || channel.type !== ChannelType.GuildText || typeof channel.setRateLimitPerUser !== 'function') {
            return interaction.reply({ content: 'Slowmode can only be set in a standard text channel.', ephemeral: true });
        }
        const seconds = options.getInteger('seconds', true);
        await channel.setRateLimitPerUser(seconds, reason);
        logEvent('moderation_action', {
            guildId: guild.id,
            channelId: interaction.channelId,
            actorId: interaction.user.id,
            command: commandName,
            slowmodeSeconds: seconds,
            reason
        });
        return interaction.reply({
            content: seconds === 0
                ? 'Slowmode disabled for this channel.'
                : `Slowmode set to ${seconds} second(s) between messages.`,
            ephemeral: true
        });
    }

    if (['timeout', 'warn', 'kick', 'ban'].includes(commandName)) {
        targetUser = options.getUser('target');
        if (
            targetUser.id === config.ownerId ||
            targetUser.id === interaction.user.id ||
            targetUser.id === client.user.id
        ) {
            return interaction.reply({ content: 'You cannot moderate yourself, Silena, or the configured bot owner.', ephemeral: true });
        }
        targetMember = await guild.members.fetch(targetUser.id).catch(error => {
            if (error.code !== 10007) throw error;
            return null;
        });
    }

    if (commandName === 'clear') {
        const amount = options.getInteger('amount');
        const targetUser = options.getUser('user');
        if (targetUser) {
            if (amount !== null && (!Number.isInteger(amount) || amount < 1 || amount > 1000)) {
                return interaction.reply({ content: 'The user-filter deletion cap must be between 1 and 1,000.', ephemeral: true });
            }
            return prepareUserPurge(interaction, targetUser, amount || 1000, reason);
        }
        if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
            return interaction.reply({
                content: 'Provide an amount from 1 to 100, or select a user to scan up to 1,000 recent messages.',
                ephemeral: true
            });
        }
        if (!interaction.channel?.isTextBased() || !interaction.channel.bulkDelete) {
            return interaction.reply({ content: 'This command can only be used in a text channel.', ephemeral: true });
        }

        const deleted = await interaction.channel.bulkDelete(amount, true);
        logEvent('moderation_action', {
            guildId: guild.id,
            channelId: interaction.channelId,
            actorId: interaction.user.id,
            command: commandName,
            amount: deleted.size
        });
        return interaction.reply({
            content: `Deleted ${deleted.size} message(s). Messages older than 14 days are not eligible for bulk deletion.`,
            ephemeral: true
        });
    }

    if (commandName === 'timeout') {
        if (!targetMember) return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        if (!targetMember.moderatable) return interaction.reply({ content: 'I cannot timeout this user due to role hierarchy.', ephemeral: true });

        const duration = options.getInteger('duration');
        await targetMember.timeout(duration * 60 * 1000, reason);
        const dmSent = await notifyModerationTarget({
            user: targetUser,
            guildId: guild.id,
            guildName: guild.name,
            action: 'timeout',
            reason,
            durationMinutes: duration,
            logEvent,
            reportError
        });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            durationMinutes: duration,
            dmSent,
            reason
        });

        const embed = new EmbedBuilder()
            .setTitle('Member Timed Out')
            .setColor(0xFEE75C)
            .addFields(
                { name: 'User', value: targetUser.tag, inline: true },
                { name: 'Duration', value: `${duration} minute(s)`, inline: true },
                { name: 'DM notice', value: dmSent ? 'Sent' : 'Could not be delivered', inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'warn') {
        if (!targetMember) return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        const dmSent = await notifyModerationTarget({
            user: targetUser,
            guildId: guild.id,
            guildName: guild.name,
            action: 'warning',
            reason,
            logEvent,
            reportError
        });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            dmSent,
            reason
        });

        const embed = new EmbedBuilder()
            .setTitle('Warning Issued')
            .setColor(0xED4245)
            .addFields(
                { name: 'User', value: targetUser.tag, inline: true },
                { name: 'Moderator', value: interaction.user.tag, inline: true },
                { name: 'DM notice', value: dmSent ? 'Sent' : 'Could not be delivered', inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'kick') {
        if (!targetMember) return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        if (!targetMember.kickable) return interaction.reply({ content: 'I cannot kick this user due to role hierarchy.', ephemeral: true });

        await targetMember.kick(reason);
        const dmSent = await notifyModerationTarget({
            user: targetUser,
            guildId: guild.id,
            guildName: guild.name,
            action: 'kick',
            reason,
            logEvent,
            reportError
        });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            dmSent,
            reason
        });
        return interaction.reply({ content: `**${targetUser.tag}** was kicked. Reason: ${reason}. DM notice ${dmSent ? 'sent' : 'could not be delivered'}.` });
    }

    if (commandName === 'ban') {
        if (targetMember && !targetMember.bannable) {
            return interaction.reply({ content: 'I cannot ban this user due to role hierarchy.', ephemeral: true });
        }

        await guild.members.ban(targetUser.id, { reason });
        const dmSent = await notifyModerationTarget({
            user: targetUser,
            guildId: guild.id,
            guildName: guild.name,
            action: 'ban',
            reason,
            logEvent,
            reportError
        });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            dmSent,
            reason
        });
        return interaction.reply({ content: `**${targetUser.tag}** was banned. Reason: ${reason}. DM notice ${dmSent ? 'sent' : 'could not be delivered'}.` });
    }

    return interaction.reply({ content: 'Unknown command.', ephemeral: true });
}

async function handleTicketOpen(interaction) {
    const requiredBotPermissions = PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles;
    if (!interaction.appPermissions?.has(requiredBotPermissions)) {
        return interaction.reply({
            content: 'Silena needs Manage Channels and Manage Roles permissions to create private tickets.',
            ephemeral: true
        });
    }

    const key = `${interaction.guildId}:${interaction.user.id}`;
    if (openingTickets.has(key)) {
        return interaction.reply({ content: 'Your ticket is already being created. Please wait a moment.', ephemeral: true });
    }
    openingTickets.add(key);

    try {
        await interaction.deferReply({ ephemeral: true });
        const existing = await findOpenTicket(interaction.guild, interaction.user.id);
        if (existing) {
            return interaction.editReply(`You already have an open ticket: <#${existing.id}>.`);
        }
        const subject = interaction.options?.getString('subject')?.trim() || 'Support request';

        const ticket = await createPrivateTicket({
            guild: interaction.guild,
            opener: interaction.user,
            staffRoleId: config.staffRoleId,
            botUserId: client.user.id,
            subject
        });
        logEvent('ticket_opened', {
            guildId: interaction.guildId,
            channelId: ticket.id,
            openerId: interaction.user.id,
            staffRoleId: config.staffRoleId,
            subject
        });
        return interaction.editReply(`Your private ticket is ready: <#${ticket.id}>.`);
    } catch (error) {
        reportError('Ticket creation failed', error);
        if (!interaction.deferred && !interaction.replied) {
            return interaction.reply({ content: `Could not create your ticket: ${error.message}`, ephemeral: true });
        }
        if (error.cleanupError) {
            reportError(`Failed to clean up ticket channel ${error.orphanedChannelId}`, error.cleanupError);
            return interaction.editReply(
                `Ticket setup failed because staff could not be notified, and cleanup also failed. Please contact staff; the unnotified channel is <#${error.orphanedChannelId}>.`
            );
        }
        if (error.existingTicketId) {
            return interaction.editReply(`You already have an open ticket: <#${error.existingTicketId}>.`);
        }
        return interaction.editReply(`Could not create your ticket: ${error.message}`);
    } finally {
        openingTickets.delete(key);
    }
}

async function handleTicketClose(interaction) {
    const channel = interaction.channel;
    const ticket = parseTicketTopic(channel?.topic);
    if (!ticket) {
        return interaction.reply({ content: '/close can only be used in a Silena ticket channel.', ephemeral: true });
    }

    let memberRoleIds = [];
    if (
        interaction.user.id !== config.ownerId &&
        interaction.user.id !== ticket.openerId
    ) {
        try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            memberRoleIds = [...member.roles.cache.keys()];
        } catch (error) {
            reportError('Unable to verify ticket closer roles', error);
            return interaction.reply({ content: 'Could not verify your staff role. Please try again or contact the bot owner.', ephemeral: true });
        }
    }

    if (!canCloseTicket({
        userId: interaction.user.id,
        ownerId: config.ownerId,
        openerId: ticket.openerId,
        staffRoleId: config.staffRoleId,
        memberRoleIds
    })) {
        return interaction.reply({
            content: 'Only the ticket opener, configured staff role, or bot owner can close this ticket.',
            ephemeral: true
        });
    }

    const requiredBotPermissions = [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
    ];
    if (!interaction.appPermissions?.has(requiredBotPermissions)) {
        return interaction.reply({
            content: 'Silena needs Send Messages, Read Message History, and Manage Channels in this ticket to archive and close it.',
            ephemeral: true
        });
    }
    if (closingTickets.has(channel.id)) {
        return interaction.reply({ content: 'This ticket is already being archived. Please wait.', ephemeral: true });
    }

    const reason = interaction.options.getString('reason', true).trim();
    if (!reason) {
        return interaction.reply({ content: 'A close reason is required.', ephemeral: true });
    }

    closingTickets.add(channel.id);
    try {
        await interaction.deferReply({ ephemeral: true });
        const archiveChannel = await client.channels.fetch(config.ticketsChannelId);
        if (!archiveChannel || archiveChannel.guildId !== config.guildId || !archiveChannel.isTextBased()) {
            throw new Error(`Configured TICKETS_CHANNEL_ID ${config.ticketsChannelId} is not a text channel in the configured server.`);
        }
        const archivePermissions = archiveChannel.permissionsFor(client.user);
        if (!archivePermissions?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
            throw new Error('Silena lacks Send Messages or Attach Files permission in the configured ticket archive channel.');
        }

        const result = await closePrivateTicket(channel, archiveChannel, {
            closerId: interaction.user.id,
            closerTag: interaction.user.tag || interaction.user.username,
            reason,
            closedAt: new Date()
        });
        ticketReminders.cancel(channel.id);
        logEvent('ticket_closed', {
            guildId: interaction.guildId,
            channelId: channel.id,
            openerId: ticket.openerId,
            closerId: interaction.user.id,
            reason,
            archiveMessageId: result.archive.message.id,
            transcriptMessages: result.archive.messageCount,
            transcriptIncludedMessages: result.archive.includedMessages,
            transcriptOmittedMessages: result.archive.omittedMessages,
            transcriptScanLimitReached: result.archive.scanLimitReached
        });
        return interaction.editReply(`Transcript saved in <#${config.ticketsChannelId}> and the ticket channel was deleted. Reason: ${reason}`);
    } catch (error) {
        reportError(`Failed to archive ticket channel ${channel.id}`, error);
        if (error.ticketArchiveFailed || error.ticketCloseReasonPostFailed) {
            return interaction.editReply(`Ticket was not deleted. ${error.ticketArchiveFailed ? 'Transcript archival failed' : 'The close reason could not be posted'}: ${error.message}. Fix the configuration or permissions and retry.`);
        }
        if (error.ticketDeleteFailed) {
            return interaction.editReply(`Transcript was saved in <#${config.ticketsChannelId}>, but the ticket channel could not be deleted: ${error.message}. You may delete it manually.`);
        }
        return interaction.editReply(`Ticket was not deleted because archival could not start: ${error.message}`);
    } finally {
        closingTickets.delete(channel.id);
    }
}

function createSilenaEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setAuthor({
            name: client.user.username,
            iconURL: client.user.displayAvatarURL()
        })
        .setTitle(title)
        .setDescription(description)
        .setTimestamp();
}

client.on(Events.InteractionCreate, interaction => {
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('announcement:')) {
            announcementFlow.handleButton(interaction).catch(async error => {
                reportError('Announcement action failed', error);
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply({ content: 'The announcement action failed. Check bot logs for details.', ephemeral: true })
                        .catch(replyError => reportError('Unable to report announcement failure', replyError));
                }
            });
            return;
        }
        if (interaction.customId.startsWith('ticket-panel:')) {
            ticketPanelFlow.handleButton(interaction).catch(async error => {
                reportError('Ticket panel action failed', error);
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply({ content: 'The ticket panel action failed. Check bot logs for details.', ephemeral: true })
                        .catch(replyError => reportError('Unable to report ticket panel failure', replyError));
                }
            });
            return;
        }
        if (interaction.customId === 'ticket:create') {
            handleTicketOpen(interaction).catch(async error => {
                reportError('Ticket panel interaction failed', error);
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.reply({ content: `Could not create your ticket: ${error.message}`, ephemeral: true })
                        .catch(replyError => reportError('Unable to report ticket panel failure', replyError));
                }
            });
            return;
        }
        handleUserPurgeButton(interaction).catch(async error => {
            reportError('User purge confirmation failed', error);
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: 'The deletion operation failed; check bot logs for details.', ephemeral: true })
                    .catch(replyError => reportError('Unable to report purge failure', replyError));
            } else {
                await interaction.reply({ content: 'The deletion operation failed; check bot logs for details.', ephemeral: true })
                    .catch(replyError => reportError('Unable to report purge failure', replyError));
            }
        });
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('announcement:modal:')) {
        announcementFlow.handleModal(interaction).catch(async error => {
            reportError('Announcement modal failed', error);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({ content: 'The announcement form failed. Check bot logs for details.', ephemeral: true })
                    .catch(replyError => reportError('Unable to report announcement form failure', replyError));
            }
        });
        return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket-panel:modal:')) {
        ticketPanelFlow.handleModal(interaction).catch(async error => {
            reportError('Ticket panel form failed', error);
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({ content: 'The ticket panel form failed. Check bot logs for details.', ephemeral: true })
                    .catch(replyError => reportError('Unable to report ticket panel form failure', replyError));
            }
        });
        return;
    }

    handleCommand(interaction).catch(async error => {
        reportError(`Command ${interaction.commandName || 'unknown'} failed`, error);
        const response = { content: 'The command failed. Check the bot logs for details.', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(response).catch(replyError => reportError('Unable to report command failure', replyError));
        } else {
            await interaction.reply(response).catch(replyError => reportError('Unable to report command failure', replyError));
        }
    });
});

try {
    const healthServer = createHealthServer({
        port: process.env.PORT || 10000,
        isReady: () => client.isReady()
    });
    healthServer.on('listening', () => {
        const address = healthServer.address();
        logEvent('health_server_ready', {
            port: typeof address === 'object' && address ? address.port : null
        });
    });
    healthServer.on('error', error => reportError('Health server failed', error));
} catch (error) {
    reportError('Health server failed to start', error);
}

client.login(config.token).catch(error => {
    reportError('Discord login failed', error);
    process.exitCode = 1;
});
