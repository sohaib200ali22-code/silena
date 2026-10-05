const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createAnnouncementFlow } = require('../announcement-flow');

const ownerId = '34567890123456789';
const guildId = '23456789012345678';
const channelId = '45678901234567890';

function createHarness() {
    const sentMessages = [];
    const loggedEvents = [];
    const errors = [];
    const destination = {
        id: channelId,
        guildId,
        type: ChannelType.GuildText,
        send: async payload => {
            sentMessages.push(payload);
            return { id: `message-${sentMessages.length}` };
        },
        permissionsFor: () => ({
            has: permissions => {
                const requested = Array.isArray(permissions) ? permissions : [permissions];
                return requested.every(permission =>
                    permission === PermissionFlagsBits.SendMessages ||
                    permission === PermissionFlagsBits.EmbedLinks
                );
            }
        })
    };
    const client = {
        user: { id: '56789012345678901' },
        channels: { fetch: async id => id === channelId ? destination : null }
    };
    const flow = createAnnouncementFlow({
        client,
        config: { ownerId, guildId },
        createSilenaEmbed: (title, description) => ({ title, description, author: 'Silena', timestamp: true }),
        logEvent: (...args) => loggedEvents.push(args),
        reportError: (...args) => errors.push(args)
    });
    return { destination, errors, flow, loggedEvents, sentMessages };
}

function createInteraction(overrides = {}) {
    const interaction = {
        customId: '',
        user: { id: ownerId },
        guildId,
        inGuild: () => true,
        options: { getChannel: () => null },
        channel: null,
        reply: async payload => { interaction.replyPayload = payload; },
        showModal: async modal => { interaction.modal = modal; },
        update: async payload => { interaction.updatePayload = payload; },
        ...overrides
    };
    return interaction;
}

async function beginPreview(flow) {
    const start = createInteraction({
        options: { getChannel: () => null },
        channel: createHarness().destination
    });
    await flow.start(start);
    const modalId = start.modal.toJSON().custom_id;
    const sessionId = modalId.split(':')[2];
    const submit = createInteraction({
        customId: modalId,
        fields: {
            getTextInputValue: field => field === 'title' ? 'Update' : 'Service is back.'
        }
    });
    await flow.handleModal(submit);
    return { sessionId, submit };
}

test('collects announcement details privately and publishes only after explicit Send', async () => {
    const harness = createHarness();
    const start = createInteraction({
        options: { getChannel: () => null },
        channel: harness.destination
    });

    await harness.flow.start(start);
    assert.match(start.modal.toJSON().custom_id, /^announcement:modal:/);
    assert.equal(harness.sentMessages.length, 0);

    const sessionId = start.modal.toJSON().custom_id.split(':')[2];
    const submit = createInteraction({
        customId: start.modal.toJSON().custom_id,
        fields: {
            getTextInputValue: field => field === 'title' ? 'Update' : 'Service is back.'
        }
    });
    await harness.flow.handleModal(submit);

    assert.equal(submit.replyPayload.ephemeral, true);
    assert.match(submit.replyPayload.content, /Nothing is public/);
    assert.equal(submit.replyPayload.embeds[0].author, 'Silena');
    assert.deepEqual(harness.sentMessages, []);

    const send = createInteraction({ customId: `announcement:send:${sessionId}:1` });
    await harness.flow.handleButton(send);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0].allowedMentions, { parse: [] });
    assert.equal(harness.sentMessages[0].embeds[0].title, 'Update');
    assert.equal(harness.sentMessages[0].embeds[0].description, 'Service is back.');
    assert.match(send.updatePayload.content, /Announcement posted/);
    assert.equal(harness.loggedEvents[0][0], 'announcement_posted');
});

test('Edit reopens a prefilled modal and only the revised content is sent', async () => {
    const harness = createHarness();
    const start = createInteraction({ channel: harness.destination });
    await harness.flow.start(start);
    const sessionId = start.modal.toJSON().custom_id.split(':')[2];
    const submit = createInteraction({
        customId: start.modal.toJSON().custom_id,
        fields: { getTextInputValue: field => field === 'title' ? 'Original' : 'Draft' }
    });
    await harness.flow.handleModal(submit);

    const edit = createInteraction({ customId: `announcement:edit:${sessionId}:1` });
    await harness.flow.handleButton(edit);
    const editModal = edit.modal.toJSON();
    assert.equal(editModal.components[0].components[0].value, 'Original');
    assert.equal(editModal.components[1].components[0].value, 'Draft');

    const revised = createInteraction({
        customId: editModal.custom_id,
        fields: { getTextInputValue: field => field === 'title' ? 'Final' : 'Reviewed message' }
    });
    await harness.flow.handleModal(revised);
    assert.equal(harness.sentMessages.length, 0);

    const stalePreview = createInteraction({ customId: `announcement:send:${sessionId}:1` });
    await harness.flow.handleButton(stalePreview);
    assert.match(stalePreview.replyPayload.content, /replaced by a newer edit/);
    assert.equal(harness.sentMessages.length, 0);

    await harness.flow.handleButton(createInteraction({ customId: `announcement:send:${sessionId}:2` }));
    assert.equal(harness.sentMessages[0].embeds[0].title, 'Final');
    assert.equal(harness.sentMessages[0].embeds[0].description, 'Reviewed message');
});

test('Cancel discards the preview without sending a public announcement', async () => {
    const harness = createHarness();
    const { sessionId } = await beginPreview(harness.flow);
    const cancel = createInteraction({ customId: `announcement:cancel:${sessionId}:1` });
    await harness.flow.handleButton(cancel);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(cancel.updatePayload.content, /cancelled/);

    const stale = createInteraction({ customId: `announcement:send:${sessionId}:1` });
    await harness.flow.handleButton(stale);
    assert.match(stale.replyPayload.content, /expired/);
});

test('rejects non-owner controls and blank or over-limit modal fields', async () => {
    const harness = createHarness();
    const start = createInteraction({ channel: harness.destination });
    await harness.flow.start(start);
    const modalId = start.modal.toJSON().custom_id;
    const sessionId = modalId.split(':')[2];

    const unauthorized = createInteraction({
        customId: `announcement:send:${sessionId}:1`,
        user: { id: '67890123456789012' }
    });
    await harness.flow.handleButton(unauthorized);
    assert.match(unauthorized.replyPayload.content, /configured bot owner/);
    assert.equal(harness.sentMessages.length, 0);

    const invalid = createInteraction({
        customId: modalId,
        fields: { getTextInputValue: field => field === 'title' ? ' ' : 'A'.repeat(4001) }
    });
    await harness.flow.handleModal(invalid);
    assert.match(invalid.replyPayload.content, /non-blank title/);
    assert.equal(harness.sentMessages.length, 0);
});

test('failed delivery preserves the preview and offers a retry', async () => {
    const harness = createHarness();
    const { sessionId } = await beginPreview(harness.flow);
    harness.destination.send = async () => { throw new Error('Discord unavailable'); };
    const send = createInteraction({ customId: `announcement:send:${sessionId}:1` });
    await harness.flow.handleButton(send);
    assert.match(send.updatePayload.content, /You can edit, cancel, or try sending again/);
    assert.equal(send.updatePayload.components.length, 1);
    assert.equal(harness.errors.length, 1);
});
