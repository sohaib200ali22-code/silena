const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteUserMessages, scanRecentMessages } = require('../purge-user-messages');

function makeMessage(id, authorId, createdTimestamp, deleteAction = async () => {}) {
    return {
        id,
        author: { id: authorId },
        createdTimestamp,
        delete: deleteAction
    };
}

test('scans recent messages in pages and stops at the configured limit', async () => {
    const calls = [];
    let pageNumber = 0;
    const channel = {
        messages: {
            async fetch(options) {
                calls.push(options);
                pageNumber += 1;
                const offset = (pageNumber - 1) * 100;
                return new Map(Array.from({ length: 100 }, (_, index) => {
                    const id = String(offset + index + 1);
                    return [id, makeMessage(id, 'author', 1)];
                }));
            }
        }
    };

    const messages = await scanRecentMessages(channel);
    assert.equal(messages.length, 1000);
    assert.equal(calls.length, 10);
    assert.equal(calls[0].limit, 100);
    assert.equal(calls[1].before, '100');
});

test('reports matching, selected, skipped, and successfully deleted counts', async () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const recentTimestamp = now - 1000;
    const oldTimestamp = now - 15 * 24 * 60 * 60 * 1000;
    const messages = [
        makeMessage('1', 'target', recentTimestamp),
        makeMessage('2', 'other', recentTimestamp),
        makeMessage('3', 'target', oldTimestamp),
        makeMessage('4', 'target', recentTimestamp)
    ];
    const bulkCalls = [];
    const channel = {
        async bulkDelete(batch, filterOld) {
            bulkCalls.push({ batch, filterOld });
            return { size: batch.length };
        }
    };
    let oldDeleteReason;
    messages[2].delete = async reason => { oldDeleteReason = reason; };

    const result = await deleteUserMessages(channel, messages, 'target', 2, {
        now: () => now,
        reason: 'cleanup'
    });

    assert.equal(bulkCalls.length, 1);
    assert.equal(bulkCalls[0].filterOld, true);
    assert.deepEqual(bulkCalls[0].batch.map(message => message.id), ['1']);
    assert.equal(oldDeleteReason, 'cleanup');
    assert.deepEqual({
        scanned: result.scanned,
        matching: result.matching,
        selected: result.selected,
        deleted: result.deleted,
        skipped: result.skipped,
        failed: result.failed
    }, {
        scanned: 4,
        matching: 3,
        selected: 2,
        deleted: 2,
        skipped: 2,
        failed: 0
    });
});

test('counts failed bulk and individual deletions explicitly', async () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const messages = [
        makeMessage('recent', 'target', now - 1),
        makeMessage('old', 'target', now - 15 * 24 * 60 * 60 * 1000, async () => {
            throw new Error('Forbidden');
        })
    ];
    const channel = {
        async bulkDelete() {
            throw new Error('Missing permission');
        }
    };

    const result = await deleteUserMessages(channel, messages, 'target', 100, { now: () => now });
    assert.equal(result.deleted, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.failures.length, 2);
});

test('validates scan and deletion limits', async () => {
    await assert.rejects(scanRecentMessages({ messages: { fetch: async () => new Map() } }, 1001), /scanLimit/);
    await assert.rejects(deleteUserMessages({}, [], 'target', 0), /maxDeletes/);
});
