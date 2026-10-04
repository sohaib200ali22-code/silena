require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Auto-Mod configuration
const BANNED_WORDS = ['badword1', 'badword2']; // Add words to filter here
const INVITE_REGEX = /(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/.+/i;

client.once('ready', () => {
    console.log(`✨ ${client.user.tag} (Silena) is online and ready!`);
});

// --- Auto-Mod System ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Skip automod for Administrators
    if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

    // 1. Anti-Invite Links Filter
    if (INVITE_REGEX.test(message.content)) {
        await message.delete().catch(() => {});
        return message.channel.send(`⚠️ ${message.author}, invite links are not allowed here!`)
            .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }

    // 2. Bad Words Filter
    const containsBannedWord = BANNED_WORDS.some(word => message.content.toLowerCase().includes(word));
    if (containsBannedWord) {
        await message.delete().catch(() => {});
        return message.channel.send(`⚠️ ${message.author}, watch your language!`)
            .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }

    // 3. Anti-Mass Mentions (> 5 mentions)
    if (message.mentions.users.size > 5) {
        await message.delete().catch(() => {});
        return message.channel.send(`⚠️ ${message.author}, mass mentions are prohibited.`)
            .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000));
    }
});

// --- Admin & Moderation Slash Commands ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options } = interaction;

    // Command: /clear
    if (commandName === 'clear') {
        const amount = options.getInteger('amount');
        if (amount < 1 || amount > 100) {
            return interaction.reply({ content: 'Please provide a number between 1 and 100.', ephemeral: true });
        }

        const deleted = await interaction.channel.bulkDelete(amount, true).catch(err => {
            console.error(err);
            return null;
        });

        if (!deleted) {
            return interaction.reply({ content: 'Failed to purge messages. Messages older than 14 days cannot be bulk deleted.', ephemeral: true });
        }

        return interaction.reply({ content: `🧹 Successfully deleted ${deleted.size} messages!`, ephemeral: true });
    }

    // Command: /timeout
    if (commandName === 'timeout') {
        const user = options.getUser('target');
        const duration = options.getInteger('duration');
        const reason = options.getString('reason') || 'No reason provided';
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!targetMember) return interaction.reply({ content: 'Member not found.', ephemeral: true });
        if (!targetMember.moderatable) return interaction.reply({ content: 'I cannot timeout this user due to role hierarchy.', ephemeral: true });

        await targetMember.timeout(duration * 60 * 1000, reason);

        const embed = new EmbedBuilder()
            .setTitle('🔇 Member Timed Out')
            .setColor(0xFEE75C)
            .addFields(
                { name: 'User', value: `${user.tag}`, inline: true },
                { name: 'Duration', value: `${duration} minute(s)`, inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // Command: /warn
    if (commandName === 'warn') {
        const user = options.getUser('target');
        const reason = options.getString('reason');

        const embed = new EmbedBuilder()
            .setTitle('⚠️ Warning Issued')
            .setColor(0xED4245)
            .addFields(
                { name: 'User', value: `${user.tag}`, inline: true },
                { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
                { name: 'Reason', value: reason }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // Command: /kick
    if (commandName === 'kick') {
        const user = options.getUser('target');
        const reason = options.getString('reason') || 'No reason provided';
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (!targetMember) return interaction.reply({ content: 'Member not found.', ephemeral: true });
        if (!targetMember.kickable) return interaction.reply({ content: 'I cannot kick this user due to role hierarchy.', ephemeral: true });

        await targetMember.kick(reason);
        return interaction.reply({ content: `👞 **${user.tag}** was kicked. Reason: ${reason}` });
    }

    // Command: /ban
    if (commandName === 'ban') {
        const user = options.getUser('target');
        const reason = options.getString('reason') || 'No reason provided';
        const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);

        if (targetMember && !targetMember.bannable) {
            return interaction.reply({ content: 'I cannot ban this user due to role hierarchy.', ephemeral: true });
        }

        await interaction.guild.members.ban(user.id, { reason });
        return interaction.reply({ content: `🔨 **${user.tag}** was banned. Reason: ${reason}` });
    }
});

client.login(process.env.DISCORD_TOKEN);
