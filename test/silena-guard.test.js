const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const {
    ACCOUNT_AGE_LIMIT_MS,
    CONFIRMATION_STEPS,
    CONFIRMATION_TTL_MS,
    createSilenaGuard,
    isAccountYoungerThanLimit
} = require('../silena-guard');

const ownerId = '34567890123456789';
const guildId = '23456789012345678';

function createHarness() {
    const events = [];
    const errors = [];
    const notices = [];
    const timers = [];
    const kicked = [];
    let now = 100_000_000;
    const guard = createSilenaGuard({
        client: {},
        config: { guildId, ownerId },
        logEvent: (...args) => events.push(args),
        reportError: (...args) => errors.push(args),
        notifyModerationTarget: async details => {
            notices.push(details);
            return true;
        },
        now: () => now,
        setTimer: (callback, delay) => {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: timer => { timer.cleared = true; }
    });
    return {
        errors,
        events,
        get now() { return now; },
        notices,
        kicked,
        setNow(value) { now = value; },
        timers,
        guard
    };
}

function makeInteraction(overrides = {}) {
    const interaction = {
        user: { id: ownerId },
        guildId,
        inGuild: () => true,
        appPermissions: { has: permission => permission === PermissionFlagsBits.KickMembers },
        options: { getSubcommand: () => 'enable' },
        reply: async payload => { interaction.replyPayload = payload; },
        update: async payload => { interaction.updatePayload = payload; },
        ...overrides
    };
    return interaction;
}

async function confirmThreeTimes(harness) {
    const command = makeInteraction();
    await harness.guard.handleCommand(command);
    const firstCustomId = command.replyPayload.components[0].toJSON().components[0].custom_id;
    const sessionId = firstCustomId.split(':')[2];
    assert.equal(harness.guard.isEnabled(), false);

    const first = makeInteraction({ customId: firstCustomId });
    await harness.guard.handleButton(first);
    assert.match(first.updatePayload.content, /Step 2 of 3/);
    assert.equal(harness.guard.isEnabled(), false);

    const secondId = first.updatePayload.components[0].toJSON().components[0].custom_id;
    const second = makeInteraction({ customId: secondId });
    await harness.guard.handleButton(second);
    assert.match(second.updatePayload.content, /Final step/);
    assert.equal(harness.guard.isEnabled(), false);

    const thirdId = second.updatePayload.components[0].toJSON().components[0].custom_id;
    const third = makeInteraction({ customId: thirdId });
    await harness.guard.handleButton(third);
    assert.equal(harness.guard.isEnabled(), true);
    return { sessionId, third };
}

test('requires three distinct confirmations before enabling guard protections', async () => {
    assert.match(CONFIRMATION_STEPS[1].text, /1-hour timeout/);
    const harness = createHarness();
    await confirmThreeTimes(harness);
    assert.equal(harness.events.filter(([name]) => name === 'silena_guard_enabled').length, 1);
});

test('confirmation steps are owner-only, sequential, single-use, and expire', async () => {
    const harness = createHarness();
    const command = makeInteraction();
    await harness.guard.handleCommand(command);
    const step1 = command.replyPayload.components[0].toJSON().components[0].custom_id;
    const sessionId = step1.split(':')[2];
    assert.equal(harness.timers[0].delay, CONFIRMATION_TTL_MS);

    const outOfOrder = makeInteraction({ customId: step1.replace(/:1$/, ':2') });
    assert.match(step1, /^silena-guard:confirm:[0-9a-f-]{36}:1$/);
    assert.match(outOfOrder.customId, /^silena-guard:confirm:[0-9a-f-]{36}:2$/);
    await harness.guard.handleButton(outOfOrder);
    assert.match(outOfOrder.replyPayload.content, /stale or out of order/);

    const unauthorized = makeInteraction({
        customId: step1,
        user: { id: '45678901234567890' }
    });
    await harness.guard.handleButton(unauthorized);
    assert.match(unauthorized.replyPayload.content, /configured bot owner/);

    await harness.timers[0].callback();
    const expired = makeInteraction({ customId: step1 });
    await harness.guard.handleButton(expired);
    assert.match(expired.replyPayload.content, /expired/);
    assert.equal(harness.guard.isEnabled(), false);
    assert.ok(sessionId);
});

test('requires Kick Members permission before starting and at final confirmation', async () => {
    const harness = createHarness();
    const denied = makeInteraction({
        appPermissions: { has: () => false }
    });
    await harness.guard.handleCommand(denied);
    assert.match(denied.replyPayload.content, /needs Kick Members/);
    assert.equal(harness.timers.length, 0);

    const command = makeInteraction();
    await harness.guard.handleCommand(command);
    const firstId = command.replyPayload.components[0].toJSON().components[0].custom_id;
    const first = makeInteraction({ customId: firstId });
    await harness.guard.handleButton(first);
    const secondId = first.updatePayload.components[0].toJSON().components[0].custom_id;
    const second = makeInteraction({ customId: secondId });
    await harness.guard.handleButton(second);
    const thirdId = second.updatePayload.components[0].toJSON().components[0].custom_id;
    const third = makeInteraction({
        customId: thirdId,
        appPermissions: { has: () => false }
    });
    await harness.guard.handleButton(third);
    assert.match(third.replyPayload.content, /no longer has Kick Members/);
    assert.equal(harness.guard.isEnabled(), false);
});

test('status and disable are explicit; restart state is off', async () => {
    const harness = createHarness();
    const statusOff = makeInteraction({ options: { getSubcommand: () => 'status' } });
    await harness.guard.handleCommand(statusOff);
    assert.match(statusOff.replyPayload.content, /OFF/);

    await confirmThreeTimes(harness);
    const statusOn = makeInteraction({ options: { getSubcommand: () => 'status' } });
    await harness.guard.handleCommand(statusOn);
    assert.match(statusOn.replyPayload.content, /ON since/);

    const disable = makeInteraction({ options: { getSubcommand: () => 'disable' } });
    await harness.guard.handleCommand(disable);
    assert.equal(harness.guard.isEnabled(), false);
    assert.match(disable.replyPayload.content, /now \*\*OFF\*\*/);
});

test('kicks non-exempt accounts younger than seven days only when guard is enabled', async () => {
    const harness = createHarness();
    const base = {
        guild: { id: guildId, ownerId: '56789012345678901', name: 'Test guild' },
        user: {
            id: '67890123456789012',
            bot: false,
            createdTimestamp: harness.now - ACCOUNT_AGE_LIMIT_MS + 1
        },
        permissions: { has: () => false },
        kickable: true,
        async kick(reason) { harness.kicked.push(reason); }
    };

    assert.equal(await harness.guard.handleMemberJoin({ ...base, id: base.user.id }), false);
    assert.equal(harness.kicked.length, 0);
    await confirmThreeTimes(harness);
    assert.equal(await harness.guard.handleMemberJoin({ ...base, id: base.user.id }), true);
    assert.match(harness.kicked[0], /less than 7 days old/);
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.events.filter(([name]) => name === 'silena_guard_young_account_kicked').length, 1);
});

test('does not kick established, bot, owner, server-owner, or administrator accounts', async () => {
    const harness = createHarness();
    await confirmThreeTimes(harness);
    const makeMember = (id, overrides = {}) => ({
        id,
        guild: { id: guildId, ownerId: '56789012345678901', name: 'Test guild' },
        user: { id, bot: false, createdTimestamp: harness.now - 1000, ...overrides.user },
        permissions: { has: permission => Boolean(overrides.admin && permission === PermissionFlagsBits.Administrator) },
        kickable: true,
        kick: async () => { harness.kicked.push(id); }
    });

    assert.equal(await harness.guard.handleMemberJoin(makeMember('67890123456789012', {
        user: { bot: true }
    })), false);
    assert.equal(await harness.guard.handleMemberJoin(makeMember(ownerId)), false);
    assert.equal(await harness.guard.handleMemberJoin(makeMember('56789012345678901')), false);
    assert.equal(await harness.guard.handleMemberJoin(makeMember('78901234567890123', { admin: true })), false);
    assert.equal(await harness.guard.handleMemberJoin(makeMember('89012345678901234', {
        user: { createdTimestamp: harness.now - ACCOUNT_AGE_LIMIT_MS }
    })), false);
    assert.deepEqual(harness.kicked, []);
});

test('reports hierarchy failures and does not silently assume a kick succeeded', async () => {
    const harness = createHarness();
    await confirmThreeTimes(harness);
    const member = {
        id: '67890123456789012',
        guild: { id: guildId, ownerId: '56789012345678901', name: 'Test guild' },
        user: {
            id: '67890123456789012',
            bot: false,
            createdTimestamp: harness.now - 1
        },
        permissions: { has: () => false },
        kickable: false,
        async kick() { assert.fail('kick must not be attempted'); }
    };
    assert.equal(await harness.guard.handleMemberJoin(member), false);
    assert.equal(harness.errors.length, 1);
    assert.equal(harness.events.filter(([name]) => name === 'silena_guard_kick_failed').length, 1);
});

test('account age threshold is strict at seven days', () => {
    const now = 10_000_000;
    assert.equal(isAccountYoungerThanLimit(now - ACCOUNT_AGE_LIMIT_MS + 1, now), true);
    assert.equal(isAccountYoungerThanLimit(now - ACCOUNT_AGE_LIMIT_MS, now), false);
    assert.equal(isAccountYoungerThanLimit(Number.NaN, now), false);
});
