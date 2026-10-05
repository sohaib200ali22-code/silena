require('dotenv').config();

const {
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    PermissionFlagsBits
} = require('discord.js');
const { readConfig } = require('./config');
const { createSpamTracker, getAutomodViolation } = require('./automod');
const { createHealthServer } = require('./health-server');

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
    timeout: PermissionFlagsBits.ModerateMembers,
    warn: PermissionFlagsBits.ModerateMembers,
    kick: PermissionFlagsBits.KickMembers,
    ban: PermissionFlagsBits.BanMembers
};

function logEvent(type, details) {
    console.info(JSON.stringify({ type, at: new Date().toISOString(), ...details }));
}

function reportError(context, error) {
    console.error(`${context}:`, error);
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

client.once(Events.ClientReady, readyClient => {
    logEvent('ready', { bot: readyClient.user.tag, guildId: config.guildId });
    for (const guild of readyClient.guilds.cache.values()) {
        leaveUnconfiguredGuild(guild);
    }
    readyClient.guilds.fetch(config.guildId).then(
        guild => logEvent('configured_guild_ready', { guildId: guild.id, name: guild.name }),
        error => reportError(`Unable to access configured guild ${config.guildId}`, error)
    );
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
    handleAutomod(message).catch(error => reportError('Automod handler failed', error));
});

async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
        return interaction.reply({ content: 'This command is only available in the configured server.', ephemeral: true });
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

    const requiredBotPermission = interaction.commandName === 'warn'
        ? null
        : interaction.commandName === 'clear'
            ? PermissionFlagsBits.ManageMessages
            : interaction.commandName === 'timeout'
                ? PermissionFlagsBits.ModerateMembers
                : interaction.commandName === 'kick'
                    ? PermissionFlagsBits.KickMembers
                    : PermissionFlagsBits.BanMembers;
    if (requiredBotPermission && !interaction.appPermissions.has(requiredBotPermission)) {
        return interaction.reply({ content: 'Silena lacks the server permission required for this command.', ephemeral: true });
    }

    const { commandName, options, guild } = interaction;
    const reason = options.getString('reason') || 'No reason provided';
    let targetUser;
    let targetMember;

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
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            durationMinutes: duration,
            reason
        });

        const embed = new EmbedBuilder()
            .setTitle('Member Timed Out')
            .setColor(0xFEE75C)
            .addFields(
                { name: 'User', value: targetUser.tag, inline: true },
                { name: 'Duration', value: `${duration} minute(s)`, inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'warn') {
        if (!targetMember) return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            reason
        });

        const embed = new EmbedBuilder()
            .setTitle('Warning Issued')
            .setColor(0xED4245)
            .addFields(
                { name: 'User', value: targetUser.tag, inline: true },
                { name: 'Moderator', value: interaction.user.tag, inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'kick') {
        if (!targetMember) return interaction.reply({ content: 'That user is not a member of this server.', ephemeral: true });
        if (!targetMember.kickable) return interaction.reply({ content: 'I cannot kick this user due to role hierarchy.', ephemeral: true });

        await targetMember.kick(reason);
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            reason
        });
        return interaction.reply({ content: `**${targetUser.tag}** was kicked. Reason: ${reason}` });
    }

    if (commandName === 'ban') {
        if (targetMember && !targetMember.bannable) {
            return interaction.reply({ content: 'I cannot ban this user due to role hierarchy.', ephemeral: true });
        }

        await guild.members.ban(targetUser.id, { reason });
        logEvent('moderation_action', {
            guildId: guild.id,
            actorId: interaction.user.id,
            targetId: targetUser.id,
            command: commandName,
            reason
        });
        return interaction.reply({ content: `**${targetUser.tag}** was banned. Reason: ${reason}` });
    }

    return interaction.reply({ content: 'Unknown command.', ephemeral: true });
}

client.on(Events.InteractionCreate, interaction => {
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
