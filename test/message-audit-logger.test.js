const assert = require('node:assert/strict');
const test = require('node:test');
const { createMessageAuditLogger } = require('../message-audit-logger');

function setup() {
    const sent = [];
    const errors = [];
    const events = [];
    const logChannel = {
        guildId: 'guild-id',
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        send: async payload => {
            sent.push(payload);
            return { id: `log-${sent.length}` };
        }
    };
    const client = {
        user: { id: 'bot-id' },
        channels: { fetch: async () => logChannel }
    };
    const logger = createMessageAuditLogger({
        client,
        logsChannelId: 'logs-channel',
        configuredGuildId: 'guild-id',
        logEvent: (type, details) => events.push({ type, details }),
        reportError: (context, error) => errors.push({ context, error }),
        wait: async () => {}
    });
    return { logger, sent, errors, events };
}

function message({ id = 'message-id', content = 'hello', channelId = 'channel-id', authorId = 'user-id' } = {}) {
    const author = { id: authorId, tag: 'member#1234' };
    const channel = { id: channelId, name: 'general' };
    return {
        id,
        content,
        author,
        channel,
        channelId,
        guildId: 'guild-id',
        guild: {
            fetchAuditLogs: async () => ({
                entries: new Map([['entry-id', {
                    target: { id: authorId },
                    executor: { id: 'moderator-id', tag: 'moderator#1234' },
                    extra: { channel: { id: channelId } },
                    createdTimestamp: Date.now()
                }]])
            })
        },
        attachments: new Map(),
        embeds: [],
        createdAt: new Date('2024-01-01T00:00:00Z'),
        createdTimestamp: Date.parse('2024-01-01T00:00:00Z'),
        partial: false
    };
}

test('copies deleted message content, author ID, and uniquely matched deletion actor', async () => {
    const { logger, sent, events } = setup();
    const deleted = message();

    assert.equal(await logger.handleDelete(deleted), true);
    assert.equal(sent.length, 1);
    const fields = sent[0].embeds[0].data.fields;
    assert.match(fields.find(field => field.name === 'Author').value, /user-id/);
    assert.match(fields.find(field => field.name === 'Deleted by').value, /moderator-id/);
    assert.equal(fields.find(field => field.name === 'Content').value, 'hello');
    assert.equal(events[0].type, 'message_delete_logged');
    assert.equal(await logger.handleDelete(deleted), false);
    assert.equal(sent.length, 1);
});

test('copies edited message content before and after the edit', async () => {
    const { logger, sent, events } = setup();
    const before = message({ content: 'before' });
    const after = message({ content: 'after' });

    assert.equal(await logger.handleUpdate(before, after), true);
    const fields = sent[0].embeds[0].data.fields;
    assert.match(fields.find(field => field.name === 'Author / editor').value, /user-id/);
    assert.equal(fields.find(field => field.name === 'Before').value, 'before');
    assert.equal(fields.find(field => field.name === 'After').value, 'after');
    assert.equal(events[0].type, 'message_edit_logged');
});

test('attributes a bulk deletion only to one matching audit entry', async () => {
    const { logger, sent } = setup();
    const first = message({ id: 'one' });
    const second = message({ id: 'two' });
    first.guild.fetchAuditLogs = async () => ({
        entries: new Map([['entry-id', {
            target: { id: first.channelId },
            executor: { id: 'moderator-id', tag: 'moderator#1234' },
            extra: { count: 2 },
            createdTimestamp: Date.now()
        }]])
    });
    const messages = {
        first: () => first,
        values: function* values() { yield first; yield second; },
        size: 2
    };

    await logger.handleBulkDelete(messages);
    assert.equal(sent.length, 2);
    assert.match(sent[0].embeds[0].data.fields.find(field => field.name === 'Deleted by').value, /moderator-id/);
});

test('does not copy messages from another server or the log channel', async () => {
    const { logger, sent } = setup();
    const foreign = message();
    foreign.guildId = 'other-guild';
    const fromLogChannel = message({ channelId: 'logs-channel' });

    assert.equal(await logger.handleDelete(foreign), false);
    assert.equal(await logger.handleDelete(fromLogChannel), false);
    assert.equal(sent.length, 0);
});
