const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createTicketPanelFlow } = require('../ticket-panel-flow');

const ownerId = '34567890123456789';
const guildId = '23456789012345678';
const channelId = '45678901234567890';

function makeHarness() {
    const sentMessages = [];
    const errors = [];
    const events = [];
    const channel = {
        id: channelId,
        guildId,
        type: ChannelType.GuildText,
        permissionsFor: () => ({
            has: permissions => {
                const requested = Array.isArray(permissions) ? permissions : [permissions];
                return requested.every(permission =>
                    permission === PermissionFlagsBits.SendMessages ||
                    permission === PermissionFlagsBits.EmbedLinks
                );
            }
        }),
        send: async payload => {
            sentMessages.push(payload);
            return { id: `panel-${sentMessages.length}` };
        }
    };
    const client = {
        user: { id: '56789012345678901' },
        channels: { fetch: async id => id === channelId ? channel : null }
    };
    const flow = createTicketPanelFlow({
        client,
        config: { ownerId, guildId },
        createSilenaEmbed: (title, description) => ({ title, description, author: 'Silena', timestamp: true }),
        logEvent: (...args) => events.push(args),
        reportError: (...args) => errors.push(args)
    });
    return { channel, errors, events, flow, sentMessages };
}

function makeInteraction(overrides = {}) {
    const interaction = {
        customId: '',
        user: { id: ownerId },
        guildId,
        inGuild: () => true,
        reply: async payload => { interaction.replyPayload = payload; },
        showModal: async modal => { interaction.modal = modal; },
        update: async payload => { interaction.updatePayload = payload; },
        ...overrides
    };
    return interaction;
}

async function startWithPreview(flow, channel) {
    const start = makeInteraction({ channel });
    await flow.start(start);
    const modalId = start.modal.toJSON().custom_id;
    const sessionId = modalId.split(':')[2];
    const submit = makeInteraction({
        customId: modalId,
        fields: {
            getTextInputValue: field => field === 'title' ? 'Support center' : 'Open a private conversation with our team.'
        }
    });
    await flow.handleModal(submit);
    return { sessionId, start, submit };
}

test('ticket panel message can be edited and is only posted after explicit Send', async () => {
    const harness = makeHarness();
    const { sessionId, start, submit } = await startWithPreview(harness.flow, harness.channel);

    assert.equal(start.modal.toJSON().components[0].components[0].value, 'Need help?');
    assert.equal(submit.replyPayload.ephemeral, true);
    assert.match(submit.replyPayload.content, /Nothing is posted/);
    assert.equal(submit.replyPayload.embeds[0].author, 'Silena');
    assert.equal(harness.sentMessages.length, 0);

    const send = makeInteraction({ customId: `ticket-panel:send:${sessionId}:1` });
    await harness.flow.handleButton(send);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].embeds[0].title, 'Support center');
    assert.equal(harness.sentMessages[0].embeds[0].description, 'Open a private conversation with our team.');
    assert.equal(harness.sentMessages[0].components[0].toJSON().components[0].custom_id, 'ticket:create');
    assert.deepEqual(harness.sentMessages[0].allowedMentions, { parse: [] });
    assert.match(send.updatePayload.content, /Ticket panel posted/);
    assert.equal(harness.events[0][0], 'ticket_panel_posted');
});

test('ticket panel edit reopens prefilled form and stale buttons cannot post', async () => {
    const harness = makeHarness();
    const { sessionId, submit } = await startWithPreview(harness.flow, harness.channel);
    const edit = makeInteraction({ customId: `ticket-panel:edit:${sessionId}:1` });
    await harness.flow.handleButton(edit);
    assert.equal(edit.modal.toJSON().components[0].components[0].value, 'Support center');

    const revised = makeInteraction({
        customId: edit.modal.toJSON().custom_id,
        fields: {
            getTextInputValue: field => field === 'title' ? 'Contact support' : 'Describe your issue and our team will respond.'
        }
    });
    await harness.flow.handleModal(revised);
    assert.equal(harness.sentMessages.length, 0);
    await harness.flow.handleButton(makeInteraction({ customId: `ticket-panel:send:${sessionId}:1` }));
    assert.match(submit.replyPayload.content, /Nothing is posted/);
    assert.equal(harness.sentMessages.length, 0);

    await harness.flow.handleButton(makeInteraction({ customId: `ticket-panel:send:${sessionId}:2` }));
    assert.equal(harness.sentMessages[0].embeds[0].title, 'Contact support');
});

test('ticket panel cancel and unauthorized controls do not post a message', async () => {
    const harness = makeHarness();
    const { sessionId } = await startWithPreview(harness.flow, harness.channel);
    const unauthorized = makeInteraction({
        customId: `ticket-panel:send:${sessionId}:1`,
        user: { id: '67890123456789012' }
    });
    await harness.flow.handleButton(unauthorized);
    assert.match(unauthorized.replyPayload.content, /configured bot owner/);

    const cancel = makeInteraction({ customId: `ticket-panel:cancel:${sessionId}:1` });
    await harness.flow.handleButton(cancel);
    assert.match(cancel.updatePayload.content, /cancelled/);
    assert.equal(harness.sentMessages.length, 0);
});
