const DEFAULT_SCAN_LIMIT = 1000;
const BULK_DELETE_LIMIT = 100;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

async function scanRecentMessages(channel, scanLimit = DEFAULT_SCAN_LIMIT) {
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > DEFAULT_SCAN_LIMIT) {
        throw new RangeError(`scanLimit must be between 1 and ${DEFAULT_SCAN_LIMIT}.`);
    }
    if (!channel?.messages?.fetch) {
        throw new Error('This channel does not support message history.');
    }

    const messages = [];
    const seenIds = new Set();
    let before;

    while (messages.length < scanLimit) {
        const pageLimit = Math.min(BULK_DELETE_LIMIT, scanLimit - messages.length);
        const page = await channel.messages.fetch({
            limit: pageLimit,
            ...(before ? { before } : {})
        });
        const pageMessages = [...page.values()];
        if (pageMessages.length === 0) break;

        for (const message of pageMessages) {
            if (!seenIds.has(message.id)) {
                seenIds.add(message.id);
                messages.push(message);
            }
        }

        if (pageMessages.length < pageLimit) break;
        before = pageMessages[pageMessages.length - 1].id;
    }

    return messages.slice(0, scanLimit);
}

async function deleteUserMessages(channel, scannedMessages, userId, maxDeletes, options = {}) {
    if (!Number.isInteger(maxDeletes) || maxDeletes < 1 || maxDeletes > DEFAULT_SCAN_LIMIT) {
        throw new RangeError(`maxDeletes must be between 1 and ${DEFAULT_SCAN_LIMIT}.`);
    }

    const matchingMessages = scannedMessages.filter(message => message.author.id === userId);
    const selectedMessages = matchingMessages.slice(0, maxDeletes);
    const cutoff = (options.now || Date.now)() - BULK_DELETE_MAX_AGE_MS;
    const recentMessages = selectedMessages.filter(message => message.createdTimestamp >= cutoff);
    const oldMessages = selectedMessages.filter(message => message.createdTimestamp < cutoff);
    const failures = [];
    let deleted = 0;

    for (let index = 0; index < recentMessages.length; index += BULK_DELETE_LIMIT) {
        const batch = recentMessages.slice(index, index + BULK_DELETE_LIMIT);
        try {
            const result = await channel.bulkDelete(batch, true);
            const batchDeleted = result.size;
            deleted += batchDeleted;
            if (batchDeleted < batch.length) {
                failures.push({
                    count: batch.length - batchDeleted,
                    message: `Bulk deletion returned ${batchDeleted} of ${batch.length} messages.`
                });
            }
        } catch (error) {
            failures.push({ count: batch.length, message: error.message });
        }
    }

    for (const message of oldMessages) {
        try {
            await message.delete(options.reason);
            deleted += 1;
        } catch (error) {
            failures.push({ count: 1, message: error.message, messageId: message.id });
        }
    }

    return {
        scanned: scannedMessages.length,
        matching: matchingMessages.length,
        selected: selectedMessages.length,
        deleted,
        skipped: scannedMessages.length - deleted - failures.reduce((total, failure) => total + failure.count, 0),
        failed: failures.reduce((total, failure) => total + failure.count, 0),
        failures
    };
}

module.exports = { deleteUserMessages, scanRecentMessages };
