const assert = require('node:assert/strict');
const test = require('node:test');
const { notifyModerationTarget } = require('../moderation-notifications');

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
