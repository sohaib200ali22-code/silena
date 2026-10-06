const assert = require('node:assert/strict');
const test = require('node:test');
const { createBanActionEmbed, notifyModerationTarget } = require('../moderation-notifications');
const { BAN_NOTICE_MARKER } = require('../appeal-system');

test('sends a mention-safe DM identifying a moderation action and reason', async () => {
    let payload;
    const events = [];
    const user = {
        id: '34567890123456789',
        async send(message) {
            payload = message;
        }
    };
    const sent = await notifyModerationTarget({
        user,
        guildId: '23456789012345678',
        guildName: 'Test Server',
        action: 'timeout',
        durationMinutes: 15,
        reason: 'Repeated spam',
        logEvent: (...args) => events.push(args),
        reportError: () => assert.fail('unexpected DM error')
    });

    assert.equal(sent, true);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.match(payload.embeds[0].data.description, /Test Server/);
    assert.match(payload.embeds[0].data.description, /15 minute/);
    assert.match(payload.embeds[0].data.description, /Repeated spam/);
    assert.deepEqual(events[0], ['moderation_dm_sent', {
        guildId: '23456789012345678',
        targetId: user.id,
        action: 'timeout'
    }]);
});

test('reports DM failures without throwing into the moderation action', async () => {
    const events = [];
    const errors = [];
    const sent = await notifyModerationTarget({
        user: {
            id: '34567890123456789',
            async send() { throw new Error('DMs closed'); }
        },
        guildId: '23456789012345678',
        guildName: 'Test Server',
        action: 'warning',
        reason: 'Test',
        logEvent: (...args) => events.push(args),
        reportError: (...args) => errors.push(args)
    });

    assert.equal(sent, false);
    assert.equal(errors.length, 1);
    assert.equal(events[0][0], 'moderation_dm_failed');
});

test('ban notice explicitly says the user was banned, invites a direct reply, and marks the message', async () => {
    let payload;
    await notifyModerationTarget({
        user: { send: async message => { payload = message; } },
        guildId: '23456789012345678',
        guildName: 'Test Server',
        action: 'ban',
        reason: 'Repeated abuse',
        logEvent: () => {},
        reportError: () => assert.fail('unexpected DM error')
    });

    assert.match(payload.embeds[0].data.description, /you have been banned/i);
    assert.match(payload.embeds[0].data.description, /reply directly to this message/i);
    assert.equal(payload.embeds[0].data.footer.text, BAN_NOTICE_MARKER);
});

test('ban confirmation is a timestamped red embed with moderator and delivery details', () => {
    const embed = createBanActionEmbed({
        user: { id: '34567890123456789', tag: 'banned-user#1234' },
        moderator: { tag: 'moderator#1234' },
        reason: 'Repeated abuse',
        dmSent: false
    }).toJSON();

    assert.equal(embed.title, 'User Banned');
    assert.equal(embed.color, 0xED4245);
    assert.match(embed.fields.find(field => field.name === 'User').value, /banned-user#1234/);
    assert.equal(embed.fields.find(field => field.name === 'Moderator').value, 'moderator#1234');
    assert.equal(embed.fields.find(field => field.name === 'DM notice').value, 'Could not be delivered');
    assert.equal(embed.fields.find(field => field.name === 'Reason').value, 'Repeated abuse');
    assert.ok(embed.timestamp);
});
