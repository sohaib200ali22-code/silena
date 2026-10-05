const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

function createCommandDefinitions() {
    return [
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Delete recent messages from this channel, optionally from one user')
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Messages to delete (1-100 normally, up to 1000 with a user filter)')
                    .setMinValue(1)
                    .setMaxValue(1000))
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('Only delete this user’s messages (scan up to 1000 recent messages)'))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for deleting messages')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder()
            .setName('lock')
            .setDescription('Prevent @everyone from sending messages in this channel')
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for locking the channel')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('unlock')
            .setDescription('Restore the @everyone send-message setting inherited by this channel')
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for unlocking the channel')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('slowmode')
            .setDescription('Set or disable slowmode in this text channel')
            .addIntegerOption(option =>
                option.setName('seconds')
                    .setDescription('Delay between messages (0 disables slowmode; maximum 21600)')
                    .setRequired(true)
                    .setMinValue(0)
                    .setMaxValue(21600))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for changing slowmode')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
        new SlashCommandBuilder()
            .setName('ticket')
            .setDescription('Open a private support ticket')
            .addStringOption(option =>
                option.setName('subject')
                    .setDescription('Briefly describe what you need help with')
                    .setRequired(true)
                    .setMaxLength(100)),
        new SlashCommandBuilder()
            .setName('close')
            .setDescription('Close and archive this ticket')
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Required reason for closing this ticket')
                    .setRequired(true)
                    .setMaxLength(500)),
        new SlashCommandBuilder()
            .setName('ticket-panel')
            .setDescription('Post the Silena ticket creation panel in this channel')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('announcement')
            .setDescription('Create and preview a Silena-branded announcement')
            .addBooleanOption(option =>
                option.setName('mention_everyone')
                    .setDescription('Explicitly ask for a separate confirmation to notify everyone'))
            .addChannelOption(option =>
                option.setName('channel')
                    .setDescription('Destination channel (defaults to this channel)')
                    .addChannelTypes(ChannelType.GuildText))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('serverinfo')
            .setDescription('Show information about the configured server')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('userinfo')
            .setDescription('Show information about a server member')
            .addUserOption(option =>
                option.setName('target')
                    .setDescription('Member to inspect')
                    .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('timeout')
            .setDescription('Temporarily timeout a server member')
            .addUserOption(option =>
                option.setName('target')
                    .setDescription('The member to timeout')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('duration')
                    .setDescription('Duration in minutes (1-40320)')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(28 * 24 * 60))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for the timeout')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder()
            .setName('warn')
            .setDescription('Issue a warning to a server member')
            .addUserOption(option =>
                option.setName('target')
                    .setDescription('The member to warn')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for the warning')
                    .setRequired(true)
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder()
            .setName('kick')
            .setDescription('Kick a member from the server')
            .addUserOption(option =>
                option.setName('target')
                    .setDescription('The member to kick')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for the kick')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban a user from the server')
            .addUserOption(option =>
                option.setName('target')
                    .setDescription('The user to ban')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('reason')
                    .setDescription('Reason for the ban')
                    .setMaxLength(500))
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    ];
}

module.exports = { createCommandDefinitions };
