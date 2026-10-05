const assert = require('node:assert/strict');
const test = require('node:test');
const { registerGuildCommands } = require('../register-commands');

test('registers the existing Silena commands to the configured guild', async () => {
    let request;
    const rest = {
        async put(route, options) {
            request = { route, options };
        }
    };
    const config = {
        token: 'test-token',
        clientId: '12345678901234567',
        guildId: '23456789012345678'
    };

    const result = await registerGuildCommands(config, rest);

    assert.equal(request.route, `/applications/${config.clientId}/guilds/${config.guildId}/commands`);
    assert.deepEqual(request.options.body.map(command => command.name), [
        'clear',
        'timeout',
        'warn',
        'kick',
        'ban'
    ]);
    assert.deepEqual(result, { count: 5, guildId: config.guildId });
});

test('propagates Discord REST registration failures', async () => {
    const failure = new Error('Discord API unavailable');
    const rest = { put: async () => { throw failure; } };

    await assert.rejects(
        registerGuildCommands({
            token: 'test-token',
            clientId: '12345678901234567',
            guildId: '23456789012345678'
        }, rest),
        error => error === failure
    );
});
