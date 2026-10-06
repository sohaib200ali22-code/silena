const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const {
    canCloseTicket,
    closePrivateTicket,
    createPrivateTicket,
    findOpenTicket,
    parseTicketTopic
} = require('../ticket-system');

const opener = {
    id: '34567890123456789',
    username: 'Ticket User',
    tag: 'Ticket User#1234'
};
const staffRole = { id: '45678901234567890', mentionable: true };

function createGuild(overrides = {}) {
    const calls = { createdOptions: null, notifications: [], deleted: false };
    const channel = {
        id: '56789012345678901',
        name: 'ticket-help-ticket-user-6789',
        guildId: '23456789012345678',
        topic: `silena-ticket:v1:open:${opener.id}`,
        messages: { async fetch() { return new Map(); } },
        async send(message) {
            calls.notifications.push(message);
        },
        async delete() {
            calls.deleted = true;
        }
    };
    const guild = {
        id: '23456789012345678',
        roles: { fetch: async () => staffRole },
        members: { me: { permissions: { has: () => false } } },
        channels: {
            async fetch() {
                return new Map();
            },
            async create(options) {
                calls.createdOptions = options;
                return channel;
            }
        },
        ...overrides
    };
    return { guild, channel, calls };
}

test('creates a private ticket and only allows the configured staff role ping', async () => {
    const { guild, channel, calls } = createGuild();
    const created = await createPrivateTicket({
        guild,
        opener,
        staffRoleId: staffRole.id,
        botUserId: '67890123456789012',
        subject: 'Login help'
    });

    assert.equal(created, channel);
    assert.deepEqual(calls.createdOptions.permissionOverwrites.map(overwrite => overwrite.id), [
        guild.id,
        opener.id,
        staffRole.id,
        '67890123456789012'
    ]);
    assert.ok(calls.createdOptions.permissionOverwrites[0].deny.includes(PermissionFlagsBits.ViewChannel));
    assert.deepEqual(calls.notifications[0].allowedMentions, {
        parse: [],
        roles: [staffRole.id]
    });
    assert.match(calls.notifications[0].content, new RegExp(`<@&${staffRole.id}>`));
    assert.equal(
        calls.notifications[1].components[0].toJSON().components[0].custom_id,
        'ticket:close'
    );
    assert.match(calls.notifications[1].content, /reason/i);
    assert.equal(parseTicketTopic(channel.topic).openerId, opener.id);
});

test('does not create a duplicate open ticket', async () => {
    const existing = {
        id: '56789012345678901',
        topic: `silena-ticket:v1:open:${opener.id}`
    };
    let createCalled = false;
    const { guild } = createGuild({
        channels: {
            async fetch() {
                return new Map([[existing.id, existing]]);
            },
            async create() {
                createCalled = true;
            }
        }
    });

    await assert.rejects(
        createPrivateTicket({
            guild,
            opener,
            staffRoleId: staffRole.id,
            botUserId: '67890123456789012',
            subject: 'Another ticket'
        }),
        error => error.existingTicketId === existing.id
    );
    assert.equal(createCalled, false);
});

test('rolls back the created channel when staff notification fails', async () => {
    const { guild, channel, calls } = createGuild();
    channel.send = async () => { throw new Error('Missing Send Messages'); };

    await assert.rejects(
        createPrivateTicket({
            guild,
            opener,
            staffRoleId: staffRole.id,
            botUserId: '67890123456789012',
            subject: 'Help'
        }),
        /Missing Send Messages/
    );
    assert.equal(calls.deleted, true);
});

test('reports an orphan channel when rollback after notification failure also fails', async () => {
    const { guild, channel } = createGuild();
    channel.send = async () => { throw new Error('Missing Send Messages'); };
    channel.delete = async () => { throw new Error('Missing Manage Channels'); };

    await assert.rejects(
        createPrivateTicket({
            guild,
            opener,
            staffRoleId: staffRole.id,
            botUserId: '67890123456789012',
            subject: 'Help'
        }),
        error => error.orphanedChannelId === channel.id && error.cleanupError.message === 'Missing Manage Channels'
    );
});

test('requires a valid pingable staff role configuration', async () => {
    const { guild } = createGuild({
        roles: { fetch: async () => null }
    });
    await assert.rejects(
        createPrivateTicket({
            guild,
            opener,
            staffRoleId: staffRole.id,
            botUserId: '67890123456789012',
            subject: 'Help'
        }),
        /staff role .* was not found/
    );

    const notMentionableGuild = createGuild({
        roles: { fetch: async () => ({ ...staffRole, mentionable: false }) }
    }).guild;
    await assert.rejects(
        createPrivateTicket({
            guild: notMentionableGuild,
            opener,
            staffRoleId: staffRole.id,
            botUserId: '67890123456789012',
            subject: 'Help'
        }),
        /staff role must be mentionable/
    );
});

test('only members with the configured staff role can close a ticket', () => {
    const args = {
        staffRoleId: staffRole.id,
        memberRoleIds: []
    };
    assert.equal(canCloseTicket({
        ...args,
        memberRoleIds: [staffRole.id]
    }), true);
    assert.equal(canCloseTicket(args), false);
});

test('closing archives the transcript before deleting the private channel', async () => {
    const calls = [];
    const channel = {
        id: '56789012345678901',
        guildId: '23456789012345678',
        topic: `silena-ticket:v1:open:${opener.id}`,
        name: 'ticket-help',
        messages: { async fetch() { return new Map(); } },
        async send(message) {
            calls.push(['send', message]);
        },
        async delete(reason) {
            calls.push(['delete', reason]);
        }
    };
    const archiveChannel = {
        guildId: channel.guildId,
        isTextBased: () => true,
        async send(message) {
            calls.push(['archive', message]);
            return { id: '67890123456789012' };
        }
    };

    await closePrivateTicket(channel, archiveChannel, {
        closerId: '78901234567890123',
        closerTag: 'Staff#1234',
        reason: 'Issue resolved'
    });

    assert.equal(calls[0][0], 'send');
    assert.match(calls[0][1].content, /Reason: Issue resolved/);
    assert.equal(calls[1][0], 'archive');
    assert.match(calls[1][1].content, /Reason: Issue resolved/);
    assert.equal(calls[1][1].files[0].name, `ticket-${channel.id}-transcript.txt`);
    assert.equal(calls[2][0], 'delete');
});

test('does not delete ticket if transcript archival fails', async () => {
    const calls = [];
    const channel = {
        id: '56789012345678901',
        guildId: '23456789012345678',
        topic: `silena-ticket:v1:closed:${opener.id}`,
        name: 'ticket-help',
        messages: { async fetch() { return new Map(); } },
        async send() { calls.push('close-reason'); },
        async delete() { calls.push('delete'); }
    };
    const archiveChannel = {
        guildId: channel.guildId,
        isTextBased: () => true,
        async send() {
            throw new Error('Archive denied');
        }
    };

    await assert.rejects(closePrivateTicket(channel, archiveChannel, {
        closerId: opener.id,
        closerTag: opener.tag,
        reason: 'Retry closure'
    }), error => error.ticketArchiveFailed && error.message === 'Archive denied');
    assert.deepEqual(calls, ['close-reason']);
});

test('only open or closed Silena ticket topics are accepted', async () => {
    assert.equal(parseTicketTopic('unrelated channel'), null);
    assert.equal(await findOpenTicket({
        channels: { fetch: async () => new Map([['closed', { topic: `silena-ticket:v1:closed:${opener.id}` }]]) }
    }, opener.id), null);
});
