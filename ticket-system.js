const { ChannelType, PermissionFlagsBits } = require('discord.js');

const TICKET_TOPIC_PREFIX = 'silena-ticket:v1';

function parseTicketTopic(topic) {
    const match = new RegExp(`^${TICKET_TOPIC_PREFIX}:(open|closed):(\\d{17,20})$`).exec(topic || '');
    if (!match) return null;
    return { status: match[1], openerId: match[2] };
}

function makeTicketTopic(status, openerId) {
    return `${TICKET_TOPIC_PREFIX}:${status}:${openerId}`;
}

function makeTicketChannelName(subject, userName, userId) {
    const slug = subject
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 35) || 'support';
    const userSlug = userName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 16) || 'user';
    return `ticket-${slug}-${userSlug}-${userId.slice(-4)}`.slice(0, 100);
}

async function findOpenTicket(guild, openerId) {
    const channels = await guild.channels.fetch();
    return [...channels.values()].find(channel => {
        const ticket = parseTicketTopic(channel.topic);
        return ticket?.status === 'open' && ticket.openerId === openerId;
    }) || null;
}

async function createPrivateTicket({ guild, opener, staffRoleId, botUserId, subject }) {
    const staffRole = await guild.roles.fetch(staffRoleId);
    if (!staffRole) {
        throw new Error(`Configured staff role ${staffRoleId} was not found in this server.`);
    }
    const botMember = guild.members.me;
    if (
        !staffRole.mentionable &&
        !botMember?.permissions.has(PermissionFlagsBits.MentionEveryone)
    ) {
        throw new Error('The staff role must be mentionable, or the bot must have Mention Everyone permission, to notify staff.');
    }

    const existingTicket = await findOpenTicket(guild, opener.id);
    if (existingTicket) {
        const error = new Error(`You already have an open ticket: ${existingTicket}.`);
        error.existingTicketId = existingTicket.id;
        throw error;
    }

    const created = await guild.channels.create({
        name: makeTicketChannelName(subject, opener.username, opener.id),
        type: ChannelType.GuildText,
        topic: makeTicketTopic('open', opener.id),
        permissionOverwrites: [
            {
                id: guild.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: opener.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            },
            {
                id: staffRole.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.EmbedLinks
                ]
            },
            {
                id: botUserId,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.ManageMessages
                ]
            }
        ]
    });

    try {
        await created.send({
            content: `<@&${staffRole.id}> New ticket from **${opener.tag || opener.username}**: **${subject}**`,
            allowedMentions: {
                parse: [],
                roles: [staffRole.id]
            }
        });
    } catch (error) {
        try {
            await created.delete('Ticket setup failed because staff could not be notified');
        } catch (cleanupError) {
            error.orphanedChannelId = created.id;
            error.cleanupError = cleanupError;
        }
        throw error;
    }

    return created;
}

function canCloseTicket({ userId, ownerId, openerId, staffRoleId, memberRoleIds }) {
    return userId === ownerId || userId === openerId || memberRoleIds.includes(staffRoleId);
}

async function closePrivateTicket(channel, { closerId, closerTag, reason }) {
    const ticket = parseTicketTopic(channel.topic);
    if (!ticket) throw new Error('This channel is not a Silena ticket.');

    if (ticket.status === 'open') {
        await channel.send({
            content: `Ticket closed by ${closerTag} (<@${closerId}>). Reason: ${reason}`,
            allowedMentions: { parse: [] }
        });
        await channel.setTopic(makeTicketTopic('closed', ticket.openerId), `Ticket closed: ${reason}`);
    }
    if (!channel.name.startsWith('closed-')) {
        await channel.setName(`closed-${channel.name}`.slice(0, 100), `Ticket closed: ${reason}`);
    }

    await channel.permissionOverwrites.edit(
        ticket.openerId,
        {
            ViewChannel: false,
            SendMessages: false
        },
        { reason: `Ticket closed: ${reason}` }
    );
    return ticket;
}

module.exports = {
    canCloseTicket,
    closePrivateTicket,
    createPrivateTicket,
    findOpenTicket,
    makeTicketChannelName,
    makeTicketTopic,
    parseTicketTopic
};
