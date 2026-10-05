const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MAX_TRANSCRIPT_BYTES,
    archiveTicketTranscript,
    buildTicketTranscript
} = require('../ticket-transcript');

const openerId = '34567890123456789';

function makeMessage(id, timestamp, content, authorId = openerId) {
    return {
        id,
        createdTimestamp: timestamp,
        createdAt: new Date(timestamp),
        author: {
            id: authorId,
            tag: `User${authorId}#1234`,
            username: `User${authorId}`
        },
        content,
        attachments: new Map([['attachment', { url: 'https://example.com/file.png' }]]),
        embeds: []
    };
}

function createTicketChannel(messages) {
    const pages = [...messages].reverse();
    return {
        id: '56789012345678901',
        guildId: '23456789012345678',
        name: 'ticket-help',
        topic: `silena-ticket:v1:open:${openerId}`,
        messages: {
            async fetch({ limit, before }) {
                const beforeIndex = before ? pages.findIndex(message => message.id === before) : -1;
                const offset = before ? beforeIndex + 1 : 0;
                return new Map(pages.slice(offset, offset + limit).map(message => [message.id, message]));
            }
        }
    };
}

test('builds an oldest-first transcript with close reason, authors, times, and attachment links', async () => {
    const messages = [
        makeMessage('2', 2000, 'Second message', '45678901234567890'),
        makeMessage('1', 1000, 'First message')
    ];
    const transcript = await buildTicketTranscript(createTicketChannel(messages), {
        closeReason: 'Issue resolved',
        closedBy: { id: '45678901234567890', tag: 'Staff#1234' },
        closedAt: new Date('2026-10-05T00:00:00.000Z')
    });
    const content = transcript.buffer.toString('utf8');
    assert.ok(content.indexOf('First message') < content.indexOf('Second message'));
    assert.match(content, /Close reason: Issue resolved/);
    assert.match(content, /User34567890123456789#1234 \(34567890123456789\)/);
    assert.match(content, /1970-01-01T00:00:01.000Z/);
    assert.match(content, /\[attachment\] https:\/\/example\.com\/file\.png/);
    assert.equal(transcript.includedMessages, 2);
});

test('caps transcript output below the archive attachment limit and marks truncation', async () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
        makeMessage(String(index + 1), index + 1, 'x'.repeat(500000))
    );
    const transcript = await buildTicketTranscript(createTicketChannel(messages), {
        closeReason: 'Resolved',
        closedBy: { id: openerId, tag: 'Owner#1234' }
    });

    assert.ok(transcript.buffer.length < MAX_TRANSCRIPT_BYTES);
    assert.ok(transcript.omittedMessages > 0);
    assert.match(transcript.buffer.toString('utf8'), /Transcript truncated/);
});

test('does not archive when the archive channel is invalid or in another guild', async () => {
    let called = false;
    const channel = createTicketChannel([]);
    const archiveChannel = {
        guildId: '99999999999999999',
        isTextBased: () => true,
        async send() {
            called = true;
        }
    };
    await assert.rejects(
        archiveTicketTranscript(channel, archiveChannel, {
            closeReason: 'Done',
            closedBy: { id: openerId, tag: 'Owner' }
        }),
        /must belong to the configured server/
    );
    assert.equal(called, false);
});

test('uploads a .txt transcript and explicitly disables mentions', async () => {
    let payload;
    const channel = createTicketChannel([]);
    const archiveChannel = {
        guildId: channel.guildId,
        isTextBased: () => true,
        async send(message) {
            payload = message;
            return { id: '78901234567890123' };
        }
    };
    const result = await archiveTicketTranscript(channel, archiveChannel, {
        closeReason: 'Resolved',
        closedBy: { id: openerId, tag: 'Owner#1234' }
    });
    assert.equal(result.message.id, '78901234567890123');
    assert.match(payload.files[0].name, /\.txt$/);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.match(payload.content, /Reason: Resolved/);
});
