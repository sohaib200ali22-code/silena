const assert = require('node:assert/strict');
const test = require('node:test');
const { readConfig } = require('../config');

const validEnvironment = {
    DISCORD_TOKEN: 'test-token-not-a-real-secret',
    CLIENT_ID: '12345678901234567',
    GUILD_ID: '23456789012345678',
    OWNER_ID: '34567890123456789',
    STAFF_ROLE_ID: '45678901234567890',
    TICKETS_CHANNEL_ID: '56789012345678901',
    LOGS_CHANNEL_ID: '67890123456789012'
};

test('requires all credentials and IDs', () => {
    assert.throws(() => readConfig({}), /DISCORD_TOKEN must be set/);
    assert.throws(() => readConfig({ ...validEnvironment, OWNER_ID: '' }), /OWNER_ID must be set/);
    assert.throws(() => readConfig({ ...validEnvironment, STAFF_ROLE_ID: '' }), /STAFF_ROLE_ID must be set/);
    assert.throws(() => readConfig({ ...validEnvironment, TICKETS_CHANNEL_ID: '' }), /TICKETS_CHANNEL_ID must be set/);
    assert.throws(() => readConfig({ ...validEnvironment, LOGS_CHANNEL_ID: '' }), /LOGS_CHANNEL_ID must be set/);
});

test('rejects malformed Discord IDs', () => {
    assert.throws(
        () => readConfig({ ...validEnvironment, GUILD_ID: 'not-an-id' }),
        /GUILD_ID must be a Discord ID/
    );
    assert.throws(
        () => readConfig({ ...validEnvironment, STAFF_ROLE_ID: 'not-a-role-id' }),
        /STAFF_ROLE_ID must be a Discord ID/
    );
    assert.throws(
        () => readConfig({ ...validEnvironment, TICKETS_CHANNEL_ID: 'not-a-channel-id' }),
        /TICKETS_CHANNEL_ID must be a Discord ID/
    );
    assert.throws(
        () => readConfig({ ...validEnvironment, LOGS_CHANNEL_ID: 'not-a-channel-id' }),
        /LOGS_CHANNEL_ID must be a Discord ID/
    );
});

test('applies conservative automod defaults and reads overrides', () => {
    assert.deepEqual(readConfig(validEnvironment), {
        token: validEnvironment.DISCORD_TOKEN,
        clientId: validEnvironment.CLIENT_ID,
        guildId: validEnvironment.GUILD_ID,
        ownerId: validEnvironment.OWNER_ID,
        staffRoleId: validEnvironment.STAFF_ROLE_ID,
        ticketsChannelId: validEnvironment.TICKETS_CHANNEL_ID,
        logsChannelId: validEnvironment.LOGS_CHANNEL_ID,
        blockInvites: true,
        blockLinks: false,
        spamMaxMessages: 5,
        spamWindowSeconds: 8
    });

    assert.equal(readConfig({
        ...validEnvironment,
        BLOCK_INVITES: 'false',
        BLOCK_LINKS: 'true',
        SPAM_MAX_MESSAGES: '10',
        SPAM_WINDOW_SECONDS: '15'
    }).blockLinks, true);
});

test('rejects invalid automod settings', () => {
    assert.throws(() => readConfig({ ...validEnvironment, BLOCK_LINKS: 'sometimes' }), /BLOCK_LINKS must be/);
    assert.throws(() => readConfig({ ...validEnvironment, SPAM_MAX_MESSAGES: '2' }), /SPAM_MAX_MESSAGES must be/);
});
