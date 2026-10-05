const assert = require('node:assert/strict');
const test = require('node:test');
const { setChannelLocked } = require('../channel-lock');

function createChannel() {
    const calls = [];
    const channel = {
        guild: { roles: { everyone: { id: 'everyone-role' } } },
        isTextBased: () => true,
        isVoiceBased: () => false,
        isThread: () => false,
        permissionOverwrites: {
            async edit(...args) {
                calls.push(args);
            }
        }
    };
    return { channel, calls };
}

test('lock denies @everyone sending while preserving unrelated overwrites', async () => {
    const { channel, calls } = createChannel();
    await setChannelLocked(channel, true, 'Maintenance');

    assert.deepEqual(calls, [[
        { id: 'everyone-role' },
        { SendMessages: false },
        { reason: 'Maintenance' }
    ]]);
});

test('unlock clears only the @everyone send-message override', async () => {
    const { channel, calls } = createChannel();
    await setChannelLocked(channel, false, 'Maintenance finished');

    assert.deepEqual(calls, [[
        { id: 'everyone-role' },
        { SendMessages: null },
        { reason: 'Maintenance finished' }
    ]]);
});

test('rejects threads and channels without permission overwrites', async () => {
    const { channel } = createChannel();
    await assert.rejects(setChannelLocked({ ...channel, isThread: () => true }, true, 'reason'), /text channel/);
    await assert.rejects(setChannelLocked({ ...channel, isVoiceBased: () => true }, true, 'reason'), /text channel/);
    await assert.rejects(
        setChannelLocked({}, false, 'reason'),
        /text channel/
    );
});

test('requires an explicit lock state', async () => {
    const { channel } = createChannel();
    await assert.rejects(setChannelLocked(channel, 'lock', 'reason'), /locked must be a boolean/);
});
