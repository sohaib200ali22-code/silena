const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommandDefinitions } = require('../commands');

test('defines moderation commands with permission defaults and bounded options', () => {
    const commands = createCommandDefinitions().map(command => command.toJSON());
    assert.deepEqual(commands.map(command => command.name), [
        'clear',
        'lock',
        'unlock',
        'ticket',
        'close',
        'ticket-panel',
        'announcement',
        'timeout',
        'warn',
        'kick',
        'ban'
    ]);
    assert.ok(commands.filter(command => !['ticket', 'close'].includes(command.name))
        .every(command => command.default_member_permissions));
    const clear = commands.find(command => command.name === 'clear');
    assert.equal(clear.options[0].max_value, 1000);
    assert.equal(clear.options[0].required, false);
    assert.equal(clear.options[1].name, 'user');
    assert.equal(commands.find(command => command.name === 'timeout').options[1].max_value, 40320);
    assert.equal(commands.find(command => command.name === 'lock').default_member_permissions, '16');
    assert.equal(commands.find(command => command.name === 'unlock').default_member_permissions, '16');
    assert.equal(clear.options[2].name, 'reason');
    assert.equal(commands.find(command => command.name === 'ticket').options[0].required, true);
    assert.equal(commands.find(command => command.name === 'close').options[0].required, true);
    assert.equal(commands.find(command => command.name === 'ticket-panel').default_member_permissions, '32');
    const announcement = commands.find(command => command.name === 'announcement');
    assert.deepEqual(announcement.options.map(option => option.name), ['mention_everyone', 'channel']);
    assert.equal(announcement.options[0].required, false);
    assert.equal(announcement.options[0].type, 5);
    assert.equal(announcement.options[1].required, false);
});
