const assert = require('node:assert/strict');
const test = require('node:test');
const { createSpamTracker, getAutomodViolation } = require('../automod');

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

    assert.equal(tracker.record('guild-a', 'user-a'), null);
    timestamp += 100;
    assert.equal(tracker.record('guild-a', 'user-a'), null);
    timestamp += 100;
    assert.equal(tracker.record('guild-a', 'user-a'), 'spam');
    assert.equal(tracker.record('guild-a', 'user-b'), null);
    assert.equal(tracker.record('guild-b', 'user-a'), null);
});

test('expires messages outside the configured spam window', () => {
    let timestamp = 1000;
    const tracker = createSpamTracker({ limit: 1, windowMs: 1000, now: () => timestamp });
    tracker.record('guild-a', 'user-a');
    timestamp += 1001;
    assert.equal(tracker.record('guild-a', 'user-a'), null);
});
