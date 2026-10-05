const assert = require('node:assert/strict');
const test = require('node:test');
const { createTicketReminderService } = require('../ticket-reminders');

const guildId = '23456789012345678';
const openerId = '34567890123456789';
const staffId = '45678901234567890';
const channelId = '56789012345678901';
const botId = '67890123456789012';

function createHarness() {
    const timers = [];
    const sentDms = [];
    const channelMessages = [];
    const events = [];
    const errors = [];
    const channel = {
        id: channelId,
        guildId,
        topic: `silena-ticket:v1:open:${openerId}`,
        name: 'ticket-help',
        messages: {
            async fetch() {
                return new Map(channelMessages.map((message, index) => [String(index), message]));
            }
        },
        async send(payload) {
            channelMessages.push({
                id: `marker-${channelMessages.length}`,
                author: { id: botId, bot: true },
                content: payload.content,
                createdTimestamp: Date.now()
            });
        }
    };
    let now = 1000;
    const client = {
        user: { id: botId },
        channels: { fetch: async id => id === channelId ? channel : null },
        users: {
            async fetch(id) {
                return {
                    id,
                    async send(payload) {
                        sentDms.push(payload);
                    }
                };
            }
        }
    };
    const service = createTicketReminderService({
        client,
        guildId,
        staffRoleId: '78901234567890123',
        ownerId: '89012345678901234',
        logEvent: (...args) => events.push(args),
        reportError: (...args) => errors.push(args),
        delayMs: 30,
        now: () => now,
        setTimer: (callback, delay) => {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: timer => { timer.cleared = true; }
    });

    function staffMessage(timestamp = now) {
        const message = {
            guildId,
            channel,
            author: { id: staffId, bot: false },
            member: { roles: { cache: { has: roleId => roleId === '78901234567890123' } } },
            createdTimestamp: timestamp
        };
        channelMessages.push(message);
        return message;
    }

    function openerMessage(timestamp = now) {
        const message = {
            guildId,
            channel,
            author: { id: openerId, bot: false },
            member: { roles: { cache: { has: () => false } } },
            createdTimestamp: timestamp
        };
        channelMessages.push(message);
        return message;
    }

    return {
        channel,
        channelMessages,
        errors,
        events,
        get now() { return now; },
        openerMessage,
        sentDms,
        service,
        setNow(value) { now = value; },
        staffMessage,
        timers
    };
}

test('reminds opener 30 minutes after staff reply and records the reminder', async () => {
    const harness = createHarness();
    harness.staffMessage(1000);
    harness.service.handleMessage(harness.channelMessages[0]);
    assert.equal(harness.timers[0].delay, 30);
    await harness.timers[0].callback();
    assert.equal(harness.sentDms.length, 1);
    assert.deepEqual(harness.sentDms[0].allowedMentions, { parse: [] });
    assert.match(harness.sentDms[0].content, /does not close your ticket/);
    assert.equal(harness.channelMessages.at(-1).content, 'Silena sent the ticket opener an inactivity reminder.');
    assert.equal(harness.events[0][0], 'ticket_inactivity_reminder_sent');
});

test('cancels the reminder when opener replies', () => {
    const harness = createHarness();
    harness.staffMessage(1000);
    harness.service.handleMessage(harness.channelMessages[0]);
    const timer = harness.timers[0];
    harness.openerMessage(1010);
    harness.service.handleMessage(harness.channelMessages[1]);
    assert.equal(timer.cleared, true);
});

test('resets the reminder on later staff activity', () => {
    const harness = createHarness();
    harness.staffMessage(1000);
    harness.service.handleMessage(harness.channelMessages[0]);
    const firstTimer = harness.timers[0];
    harness.setNow(1010);
    harness.staffMessage(1010);
    harness.service.handleMessage(harness.channelMessages[1]);
    assert.equal(firstTimer.cleared, true);
    assert.equal(harness.timers[1].delay, 30);
});

test('restores pending reminders after restart and skips already-reminded tickets', async () => {
    const harness = createHarness();
    harness.staffMessage(1000);
    await harness.service.restoreOpenTickets({
        channels: { fetch: async () => new Map([[channelId, harness.channel]]) }
    });
    assert.equal(harness.timers.length, 1);

    harness.channelMessages.push({
        author: { id: botId, bot: true },
        content: 'Silena sent the ticket opener an inactivity reminder.',
        createdTimestamp: 1010
    });
    await harness.service.restoreOpenTickets({
        channels: { fetch: async () => new Map([[channelId, harness.channel]]) }
    });
    assert.equal(harness.timers.length, 1);
});
