const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommandDefinitions } = require('../commands');

test('defines only the supported moderation commands with permission defaults', () => {
    const commands = createCommandDefinitions().map(command => command.toJSON());
    assert.deepEqual(commands.map(command => command.name), ['clear', 'timeout', 'warn', 'kick', 'ban']);
    assert.ok(commands.every(command => command.default_member_permissions));
    assert.equal(commands.find(command => command.name === 'clear').options[0].max_value, 100);
    assert.equal(commands.find(command => command.name === 'timeout').options[1].max_value, 40320);
});
