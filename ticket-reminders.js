const { parseTicketTopic } = require('./ticket-system');

const DEFAULT_REMINDER_DELAY_MS = 30 * 60 * 1000;
const HISTORY_SCAN_LIMIT = 100;
const REMINDER_MARKER = 'Silena sent the ticket opener an inactivity reminder.';

function createTicketReminderService({
    client,
    guildId,
    staffRoleId,
    ownerId,
    logEvent,
    reportError,
    delayMs = DEFAULT_REMINDER_DELAY_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now
}) {
    const timers = new Map();

    function cancel(channelId) {
        const timer = timers.get(channelId);
        if (timer) clearTimer(timer);
        timers.delete(channelId);
    }

    function isStaff(message) {
        return message.author.id === ownerId ||
            Boolean(message.member?.roles?.cache?.has(staffRoleId));
    }

    function latestRelevantMessage(messages, openerId) {
        return [...messages]
            .filter(message =>
                (message.author.bot && message.author.id === client.user.id && message.content === REMINDER_MARKER) ||
                (!message.author.bot && (message.author.id === openerId || isStaff(message)))
            )
            .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0];
    }

    function schedule(channel, openerId, staffMessageAt) {
        cancel(channel.id);
        const remaining = Math.max(0, staffMessageAt + delayMs - now());
        const timer = setTimer(async () => {
            timers.delete(channel.id);
            const ticket = parseTicketTopic(channel.topic);
            if (!ticket || ticket.status !== 'open' || ticket.openerId !== openerId) return;
            try {
                const currentChannel = await client.channels.fetch(channel.id);
                if (!currentChannel || parseTicketTopic(currentChannel.topic)?.status !== 'open') return;
                const history = await currentChannel.messages.fetch({ limit: HISTORY_SCAN_LIMIT });
                const latestRelevant = latestRelevantMessage(history.values(), openerId);
                if (!latestRelevant || latestRelevant.author.id === openerId) return;
                if (latestRelevant.author.id === client.user.id) return;
                if (latestRelevant.createdTimestamp > staffMessageAt) {
                    schedule(currentChannel, openerId, latestRelevant.createdTimestamp);
                    return;
                }
                const opener = await client.users.fetch(openerId);
                await opener.send({
                    content: `You have not replied to the latest staff message in your support ticket (${channel.name}) for 30 minutes. Reply in <#${channel.id}> when you are ready. This reminder does not close your ticket.`,
                    allowedMentions: { parse: [] }
                });
                try {
                    await currentChannel.send({
                        content: REMINDER_MARKER,
                        allowedMentions: { parse: [] }
                    });
                } catch (error) {
                    reportError(`Unable to record inactivity reminder in ticket ${channel.id}`, error);
                }
                logEvent('ticket_inactivity_reminder_sent', {
                    guildId,
                    channelId: channel.id,
                    openerId
                });
            } catch (error) {
                reportError(`Unable to send ticket inactivity reminder for ${channel.id}`, error);
                logEvent('ticket_inactivity_reminder_failed', {
                    guildId,
                    channelId: channel.id,
                    openerId,
                    error: error.message
                });
            }
        }, remaining);
        timer.unref?.();
        timers.set(channel.id, timer);
    }

    function handleMessage(message) {
        if (
            message.guildId !== guildId ||
            message.author.bot ||
            !message.channel
        ) return;
        const ticket = parseTicketTopic(message.channel.topic);
        if (!ticket || ticket.status !== 'open') return;

        if (message.author.id === ticket.openerId) {
            cancel(message.channel.id);
            return;
        }
        if (isStaff(message)) {
            schedule(message.channel, ticket.openerId, message.createdTimestamp || now());
        }
    }

    async function restoreOpenTickets(guild) {
        const channels = await guild.channels.fetch();
        for (const channel of channels.values()) {
            const ticket = parseTicketTopic(channel.topic);
            if (
                channel.guildId !== guildId ||
                ticket?.status !== 'open' ||
                !channel.messages?.fetch
            ) continue;

            try {
                const history = await channel.messages.fetch({ limit: HISTORY_SCAN_LIMIT });
                const latestRelevant = latestRelevantMessage(history.values(), ticket.openerId);
                if (
                    latestRelevant &&
                    !latestRelevant.author.bot &&
                    latestRelevant.author.id !== ticket.openerId
                ) {
                    schedule(channel, ticket.openerId, latestRelevant.createdTimestamp);
                }
            } catch (error) {
                reportError(`Unable to restore inactivity reminder for ticket ${channel.id}`, error);
            }
        }
    }

    return { cancel, handleMessage, restoreOpenTickets };
}

module.exports = {
    DEFAULT_REMINDER_DELAY_MS,
    createTicketReminderService
};
