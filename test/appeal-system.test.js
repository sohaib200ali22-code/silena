const assert = require('node:assert/strict');
const test = require('node:test');
const { BAN_NOTICE_MARKER, createAppealService } = require('../appeal-system');

const ids = {
    owner: '34567890123456789',
    user: '45678901234567890',
    guild: '23456789012345678',
    logs: '56789012345678901',
    banNotice: '67890123456789012',
    appeal: '78901234567890123'
};

function setup() {
    const sentToLogs = [];
    const dmReplies = [];
    const userDms = [];
    const logEvents = [];
    const errors = [];
    const logsChannel = {
        guildId: ids.guild,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        send: async payload => {
            sentToLogs.push(payload);
            return { id: 'appeal-log-message' };
        }
    };
    const client = {
        user: { id: 'bot-user-id' },
        channels: { fetch: async () => logsChannel },
        users: {
            fetch: async id => ({
                id,
                send: async payload => userDms.push({ id, payload })
            })
        }
    };
    const service = createAppealService({
        client,
        config: { ownerId: ids.owner, guildId: ids.guild, logsChannelId: ids.logs },
        logEvent: (...args) => logEvents.push(args),
        reportError: (...args) => errors.push(args)
    });
    const banNotice = {
        id: ids.banNotice,
        author: { id: client.user.id },
        embeds: [{ footer: { text: BAN_NOTICE_MARKER } }]
    };
    const appealMessage = {
        id: ids.appeal,
        guildId: null,
        author: { id: ids.user, tag: 'appealing-user#1234', username: 'appealing-user', bot: false },
        content: 'I understand the rules and would like another chance.',
        attachments: new Map(),
        reference: { messageId: ids.banNotice },
        fetchReference: async () => banNotice,
        reply: async payload => dmReplies.push(payload)
    };
    return { service, sentToLogs, dmReplies, userDms, logEvents, errors, client, appealMessage };
}

test('forwards a reply to a marked ban notice to the configured private logs channel', async () => {
    const { service, sentToLogs, dmReplies, logEvents, appealMessage } = setup();

    assert.equal(await service.handleMessage(appealMessage), true);
    assert.equal(sentToLogs.length, 1);
    assert.match(sentToLogs[0].embeds[0].data.title, /appeal/i);
    assert.match(sentToLogs[0].embeds[0].data.fields.find(field => field.name === 'User ID').value, new RegExp(ids.user));
    assert.equal(sentToLogs[0].components[0].components.length, 2);
    assert.deepEqual(sentToLogs[0].allowedMentions, { parse: [] });
    assert.match(dmReplies[0].content, /sent to the server owner/i);
    assert.equal(logEvents[0][0], 'ban_appeal_submitted');
});

test('ignores normal DMs and replies that do not reference a Silena ban notice', async () => {
    const { service, sentToLogs, appealMessage } = setup();

    appealMessage.reference = null;
    assert.equal(await service.handleMessage(appealMessage), false);
    appealMessage.reference = { messageId: ids.banNotice };
    appealMessage.fetchReference = async () => ({
        ...await Promise.resolve({ id: ids.banNotice, author: { id: 'another-bot' }, embeds: [] })
    });
    assert.equal(await service.handleMessage(appealMessage), false);
    assert.equal(sentToLogs.length, 0);
});

test('accepts only one submission for the same ban notice during this process', async () => {
    const { service, sentToLogs, dmReplies, appealMessage } = setup();

    assert.equal(await service.handleMessage(appealMessage), true);
    assert.equal(await service.handleMessage({ ...appealMessage, id: '89012345678901234' }), true);
    assert.equal(sentToLogs.length, 1);
    assert.match(dmReplies[1].content, /already been submitted/i);
});

function reviewInteraction({ customId, userId = ids.owner, message, guildPermissions = true, botPermissions = true }) {
    const calls = [];
    return {
        interaction: {
            customId,
            user: { id: userId, tag: 'owner#1234', username: 'owner' },
            guildId: ids.guild,
            channelId: ids.logs,
            channel: { id: ids.logs },
            guild: {
                name: 'Test Server',
                bans: { remove: async (...args) => calls.push(['unban', ...args]) }
            },
            memberPermissions: { has: () => guildPermissions },
            appPermissions: { has: () => botPermissions },
            message: {
                author: { id: 'bot-user-id' },
                embeds: [message]
            },
            reply: async payload => calls.push(['reply', payload]),
            update: async payload => calls.push(['update', payload])
        },
        calls
    };
}

function appealLogEmbed() {
    return {
        title: 'Ban appeal',
        fields: [{ name: 'User ID', value: ids.user }],
        footer: { text: `Appeal message ID: ${ids.appeal} • Ban notice ID: ${ids.banNotice}` }
    };
}

test('only owner can approve; approval unbans and updates the appeal log', async () => {
    const { service, userDms, logEvents } = setup();
    const { interaction, calls } = reviewInteraction({
        customId: `appeal:approve:${ids.user}:${ids.appeal}`,
        message: appealLogEmbed()
    });

    assert.equal(await service.handleButton(interaction), true);
    assert.equal(calls[0][0], 'unban');
    assert.equal(calls[0][1], ids.user);
    assert.equal(userDms.length, 1);
    assert.match(userDms[0].payload.content, /approved/i);
    assert.equal(calls[1][0], 'update');
    assert.deepEqual(calls[1][1].components, []);
    assert.equal(logEvents.some(([event]) => event === 'ban_appeal_approved'), true);
});

test('reject notifies the user but does not remove the ban', async () => {
    const { service, userDms, logEvents } = setup();
    const { interaction, calls } = reviewInteraction({
        customId: `appeal:reject:${ids.user}:${ids.appeal}`,
        message: appealLogEmbed()
    });

    assert.equal(await service.handleButton(interaction), true);
    assert.equal(calls.some(call => call[0] === 'unban'), false);
    assert.match(userDms[0].payload.content, /declined/i);
    assert.equal(calls[0][0], 'update');
    assert.equal(logEvents.some(([event]) => event === 'ban_appeal_rejected'), true);
});

test('rejects non-owner, mismatched appeal controls, and approval without ban permissions', async () => {
    const { service } = setup();
    const nonOwner = reviewInteraction({
        customId: `appeal:approve:${ids.user}:${ids.appeal}`,
        userId: ids.user,
        message: appealLogEmbed()
    });
    assert.equal(await service.handleButton(nonOwner.interaction), true);
    assert.match(nonOwner.calls[0][1].content, /only the configured bot owner/i);

    const mismatched = reviewInteraction({
        customId: `appeal:approve:${ids.user}:${ids.appeal}`,
        message: { ...appealLogEmbed(), fields: [{ name: 'User ID', value: ids.owner }] }
    });
    assert.equal(await service.handleButton(mismatched.interaction), true);
    assert.match(mismatched.calls[0][1].content, /not valid/i);

    const noPermission = reviewInteraction({
        customId: `appeal:approve:${ids.user}:${ids.appeal}`,
        message: appealLogEmbed(),
        botPermissions: false
    });
    assert.equal(await service.handleButton(noPermission.interaction), true);
    assert.match(noPermission.calls[0][1].content, /need Ban Members permission/i);
});
