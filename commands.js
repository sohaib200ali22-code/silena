const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

function createCommandDefinitions() {
    return [
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Delete up to 100 recent messages from this channel')
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Number of messages to delete (1-100)')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(100))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
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
