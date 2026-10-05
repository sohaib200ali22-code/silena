const assert = require('node:assert/strict');
const test = require('node:test');
const { createSpamTracker, enforceSpamBurst, getAutomodViolation } = require('../automod');

test('blocks Discord invites by default configuration', () => {
    assert.equal(
        getAutomodViolation('Join us at https://discord.gg/example', {
            blockInvites: true,
            blockLinks: false,
            mentionLimit: 5
        }),
        'invite-link'
    );
});

test('blocks ordinary links only when configured', () => {
    const options = { blockInvites: false, blockLinks: false, mentionLimit: 5 };
    assert.equal(getAutomodViolation('https://example.com', options), null);
    assert.equal(
        getAutomodViolation('https://example.com', { ...options, blockLinks: true }),
        'link'
    );
});

test('blocks mass mentions', () => {
    const options = { blockInvites: false, blockLinks: false, mentionLimit: 2 };
    assert.equal(getAutomodViolation('<@12345678901234567> <@!23456789012345678> <@&34567890123456789>', options), 'mass-mention');
    assert.equal(getAutomodViolation('hello @everyone', options), 'mass-mention');
});

test('detects message bursts per user and guild', () => {
    let timestamp = 1000;
    const tracker = createSpamTracker({ limit: 2, windowMs: 1000, now: () => timestamp });
    const messages = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];

    assert.equal(tracker.record('guild-a', 'user-a', messages[0]), null);
    timestamp += 100;
    assert.equal(tracker.record('guild-a', 'user-a', messages[1]), null);
    timestamp += 100;
    assert.deepEqual(tracker.record('guild-a', 'user-a', messages[2]), {
        violation: 'spam',
        messages
    });
    assert.equal(tracker.record('guild-a', 'user-b', {}), null);
    assert.equal(tracker.record('guild-b', 'user-a', {}), null);
});

test('expires messages outside the configured spam window', () => {
    let timestamp = 1000;
    const tracker = createSpamTracker({ limit: 1, windowMs: 1000, now: () => timestamp });
    tracker.record('guild-a', 'user-a', {});
    timestamp += 1001;
    assert.equal(tracker.record('guild-a', 'user-a', {}), null);
});

test('spam burst applies a one-hour timeout and deletes all messages that formed the burst', async () => {
    const calls = [];
    const spamMessages = [
        { id: 'one', delete: async reason => calls.push(['delete', 'one', reason]) },
        { id: 'two', delete: async reason => calls.push(['delete', 'two', reason]) }
    ];
    const member = {
        moderatable: true,
        timeout: async (duration, reason) => calls.push(['timeout', duration, reason])
    };
    const user = { id: 'user-id' };
    const events = [];
    const result = await enforceSpamBurst({
        messages: spamMessages,
        member,
        guild: {
            id: 'guild-id',
            name: 'Guild',
            members: { me: { permissions: { has: () => true } } }
        },
        user,
        notifyModerationTarget: async options => {
            calls.push(['dm', options.durationMinutes]);
            return true;
        },
        logEvent: (...args) => events.push(args),
        reportError: (...args) => assert.fail(`unexpected enforcement error: ${args[0]}`)
    });

    assert.equal(result.timeoutApplied, true);
    assert.equal(result.deletedMessages, 2);
    assert.equal(result.failedDeletes, 0);
    assert.deepEqual(calls[0].slice(0, 2), ['timeout', 60 * 60 * 1000]);
    assert.deepEqual(calls[1], ['dm', 60]);
    assert.equal(calls.filter(call => call[0] === 'delete').length, 2);
    assert.equal(events[0][0], 'automod_spam_timeout');
});

test('spam messages are still deleted if timeout permission or role hierarchy prevents timeout', async () => {
    const errors = [];
    const messages = [{ id: 'spam', delete: async () => {} }];
    const result = await enforceSpamBurst({
        messages,
        member: { moderatable: false },
        guild: { members: { me: { permissions: { has: () => false } } } },
        user: { id: 'user-id' },
        notifyModerationTarget: async () => assert.fail('should not send DM without a timeout'),
        logEvent: () => {},
        reportError: (...args) => errors.push(args)
    });

    assert.equal(result.timeoutApplied, false);
    assert.equal(result.deletedMessages, 1);
    assert.equal(errors.length, 1);
});
