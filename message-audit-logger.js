const { AuditLogEvent, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const AUDIT_LOOKBACK_MS = 15_000;
const AUDIT_RETRY_COUNT = 3;
const AUDIT_RETRY_DELAY_MS = 400;
const EMBED_FIELD_LIMIT = 1024;

function shorten(text, limit = EMBED_FIELD_LIMIT) {
    const value = text || '[empty]';
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 20)}\n[truncated; see attachment]`;
}

function attachmentLines(message) {
    const attachments = [...(message.attachments?.values?.() || [])]
        .map(attachment => `[attachment] ${attachment.url}`);
    const embeds = (message.embeds || [])
        .map(embed => embed.url)
        .filter(Boolean)
        .map(url => `[embed] ${url}`);
    return [...attachments, ...embeds];
}

function contentFile(message, label, content) {
    if (!content || content.length <= EMBED_FIELD_LIMIT) return null;
    return {
        attachment: Buffer.from(content, 'utf8'),
        name: `message-${message.id}-${label}.txt`
    };
}

function timestamp(message) {
    return message.createdAt?.toISOString?.() ||
        new Date(message.createdTimestamp || Date.now()).toISOString();
}

function createMessageAuditLogger({ client, logsChannelId, configuredGuildId, logEvent, reportError, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const recentlyLogged = new Map();

    function markRecentlyLogged(key) {
        const now = Date.now();
        for (const [entryKey, at] of recentlyLogged) {
            if (now - at >= 60_000) recentlyLogged.delete(entryKey);
        }
        if (recentlyLogged.has(key)) return false;
        recentlyLogged.set(key, now);
        return true;
    }

    function isLoggable(message) {
        return Boolean(
            message?.guildId === configuredGuildId &&
            message.channelId !== logsChannelId &&
            message.author?.id
        );
    }

    async function getLogsChannel(message) {
        if (!logsChannelId) {
            reportError('Message audit copy skipped because LOGS_CHANNEL_ID is not configured', new Error('Set LOGS_CHANNEL_ID to enable message edit/deletion copies.'));
            return null;
        }
        const channel = await client.channels.fetch(logsChannelId);
        if (
            !channel ||
            channel.guildId !== configuredGuildId ||
            typeof channel.send !== 'function' ||
            !channel.isTextBased()
        ) {
            throw new Error(`LOGS_CHANNEL_ID ${logsChannelId} is unavailable or is not a text channel in the configured server.`);
        }
        if (!channel.permissionsFor(client.user)?.has([
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles
        ])) {
            throw new Error('Silena needs Send Messages, Embed Links, and Attach Files in LOGS_CHANNEL_ID.');
        }
        return channel;
    }

    async function resolveDeleteActor(message) {
        const guild = message.guild;
        if (!guild?.fetchAuditLogs) return 'Unknown (audit log unavailable)';
        let lastError;
        for (let attempt = 0; attempt < AUDIT_RETRY_COUNT; attempt += 1) {
            if (attempt) await wait(AUDIT_RETRY_DELAY_MS);
            try {
                const auditLogs = await guild.fetchAuditLogs({
                    type: AuditLogEvent.MessageDelete,
                    limit: 10
                });
                const now = Date.now();
                const matches = [...auditLogs.entries.values()].filter(entry =>
                    entry.target?.id === message.author.id &&
                    entry.extra?.channel?.id === message.channelId &&
                    now - entry.createdTimestamp >= 0 &&
                    now - entry.createdTimestamp <= AUDIT_LOOKBACK_MS
                );
                if (matches.length === 1 && matches[0].executor?.id) {
                    const actor = matches[0].executor;
                    return `${actor.tag || actor.username || 'Unknown'} (${actor.id})`;
                }
                if (matches.length > 1) return 'Unknown (multiple matching audit-log entries)';
                lastError = null;
            } catch (error) {
                lastError = error;
            }
        }
        if (lastError) reportError(`Unable to resolve deletion actor for message ${message.id}`, lastError);
        return 'Unknown (audit log unavailable or ambiguous)';
    }

    async function sendLog(message, embed, files = []) {
        try {
            const channel = await getLogsChannel(message);
            if (!channel) return false;
            await channel.send({
                embeds: [embed],
                ...(files.length ? { files } : {}),
                allowedMentions: { parse: [] }
            });
            return true;
        } catch (error) {
            reportError(`Unable to write message audit log for message ${message.id}`, error);
            logEvent('message_audit_copy_failed', {
                guildId: message.guildId,
                channelId: message.channelId,
                messageId: message.id,
                error: error.message
            });
            return false;
        }
    }

    async function handleDelete(message) {
        if (!isLoggable(message)) return false;
        const key = `${message.channelId}:${message.id}`;
        if (!markRecentlyLogged(key)) return false;

        let hydrated = message;
        if (message.partial && typeof message.fetch === 'function') {
            try {
                hydrated = await message.fetch();
            } catch (error) {
                reportError(`Deleted message ${message.id} was partial and could not be fetched`, error);
            }
        }

        const actor = await resolveDeleteActor(hydrated);
        return logDeleted(hydrated, actor, true);
    }

    async function logDeleted(hydrated, actorLabel, alreadyTracked = false) {
        if (!isLoggable(hydrated)) return false;
        const key = `${hydrated.channelId}:${hydrated.id}`;
        if (!alreadyTracked) {
            if (!markRecentlyLogged(key)) return false;
        }
        const content = hydrated.content || '[message content unavailable; it was not cached]';
        const fields = [
            { name: 'Author', value: `${hydrated.author?.tag || hydrated.author?.username || 'Unknown'} (${hydrated.author?.id || 'unknown ID'})`, inline: true },
            { name: 'Deleted by', value: actorLabel || 'Unknown (not provided)', inline: true },
            { name: 'Channel', value: `#${hydrated.channel?.name || hydrated.channel?.id || hydrated.channelId} (${hydrated.channelId})`, inline: true },
            { name: 'Message ID', value: hydrated.id, inline: true },
            { name: 'Content', value: shorten(content) }
        ];
        const extras = attachmentLines(hydrated);
        if (extras.length) fields.push({ name: 'Attachments / embeds', value: shorten(extras.join('\n')) });

        const embed = new EmbedBuilder()
            .setTitle('Message deleted')
            .setColor(0xED4245)
            .setDescription(`Deleted at ${timestamp(hydrated)}`)
            .addFields(fields)
            .setTimestamp();
        const file = contentFile(hydrated, 'deleted', content);
        const sent = await sendLog(hydrated, embed, file ? [file] : []);
        if (sent) {
            logEvent('message_delete_logged', {
                guildId: hydrated.guildId,
                channelId: hydrated.channelId,
                messageId: hydrated.id,
                authorId: hydrated.author?.id,
                deletedBy: actorLabel || 'Unknown (not provided)'
            });
        }
        return sent;
    }

    async function handleUpdate(oldMessage, newMessage) {
        if (!isLoggable(newMessage) || !markRecentlyLogged(`${newMessage.channelId}:${newMessage.id}:update`)) return false;
        let before = oldMessage;
        let after = newMessage;
        if (newMessage.partial && typeof newMessage.fetch === 'function') {
            try {
                after = await newMessage.fetch();
            } catch (error) {
                reportError(`Edited message ${newMessage.id} new version was partial and could not be fetched`, error);
            }
        }
        if (!oldMessage.partial && (before.content || '') === (after.content || '')) return false;

        const beforeContent = oldMessage.partial
            ? '[previous content unavailable; message was not cached before edit]'
            : before.content || '[previous content was empty]';
        const afterContent = after.content || '[new content unavailable]';
        const embed = new EmbedBuilder()
            .setTitle('Message edited')
            .setColor(0x5865F2)
            .setDescription(`Edited at ${timestamp(after)}`)
            .addFields(
                { name: 'Author / editor', value: `${after.author?.tag || after.author?.username || 'Unknown'} (${after.author?.id || 'unknown ID'})`, inline: true },
                { name: 'Channel', value: `#${after.channel?.name || after.channel?.id || after.channelId} (${after.channelId})`, inline: true },
                { name: 'Message ID', value: after.id, inline: true },
                { name: 'Before', value: shorten(beforeContent) },
                { name: 'After', value: shorten(afterContent) }
            )
            .setTimestamp();
        const files = [
            contentFile(after, 'before', beforeContent),
            contentFile(after, 'after', afterContent)
        ].filter(Boolean);
        const sent = await sendLog(after, embed, files);
        if (sent) {
            logEvent('message_edit_logged', {
                guildId: after.guildId,
                channelId: after.channelId,
                messageId: after.id,
                authorId: after.author?.id
            });
        }
        return sent;
    }

    async function handleBulkDelete(messages, actorLabel = 'Unknown (bulk-delete audit attribution unavailable)') {
        const firstMessage = messages.first();
        if (!firstMessage || firstMessage.guildId !== configuredGuildId) return;
        let resolvedActor = actorLabel;
        if (actorLabel === 'Unknown (bulk-delete audit attribution unavailable)') {
            try {
                const auditLogs = await firstMessage.guild.fetchAuditLogs({
                    type: AuditLogEvent.MessageBulkDelete,
                    limit: 10
                });
                const recent = [...auditLogs.entries.values()].filter(entry =>
                    Date.now() - entry.createdTimestamp >= 0 &&
                    Date.now() - entry.createdTimestamp <= AUDIT_LOOKBACK_MS
                );
                const matches = recent.filter(entry =>
                    entry.target?.id === firstMessage.channelId &&
                    entry.extra?.count === messages.size
                );
                if (matches.length === 1 && matches[0].executor?.id) {
                    const actor = matches[0].executor;
                    resolvedActor = `${actor.tag || actor.username || 'Unknown'} (${actor.id})`;
                } else if (matches.length > 1) {
                    resolvedActor = 'Unknown (multiple matching bulk-delete audit entries)';
                }
            } catch (error) {
                reportError(`Unable to resolve bulk-delete actor for channel ${firstMessage.channelId}`, error);
            }
        }
        for (const message of messages.values()) {
            await logDeleted(message, resolvedActor);
        }
    }

    return { handleBulkDelete, handleDelete, handleUpdate, logDeleted };
}

module.exports = {
    AUDIT_LOOKBACK_MS,
    createMessageAuditLogger
};
