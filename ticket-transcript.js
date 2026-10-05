const MAX_TRANSCRIPT_BYTES = 7 * 1024 * 1024;
const MAX_TRANSCRIPT_CONTENT_BYTES = MAX_TRANSCRIPT_BYTES - 512;
const MAX_TRANSCRIPT_MESSAGES = 10000;
const PAGE_SIZE = 100;

function messageToTranscriptLine(message) {
    const timestamp = message.createdAt?.toISOString?.() ||
        new Date(message.createdTimestamp).toISOString();
    const author = `${message.author.tag || message.author.username} (${message.author.id})`;
    const content = (message.content || '').replace(/\r\n/g, '\n');
    const attachmentUrls = [...message.attachments.values()].map(attachment => attachment.url);
    const embeds = message.embeds.map(embed => embed.url).filter(Boolean);
    const extra = [
        ...attachmentUrls.map(url => `[attachment] ${url}`),
        ...embeds.map(url => `[embed] ${url}`)
    ];

    return `[${timestamp}] ${author}\n${content}${content && extra.length ? '\n' : ''}${extra.join('\n')}\n`;
}

async function buildTicketTranscript(channel, { closeReason, closedBy, closedAt = new Date() }) {
    if (!channel?.messages?.fetch) {
        throw new Error('Ticket channel history cannot be fetched.');
    }

    const ticket = parseTicketTopic(channel.topic);
    if (!ticket) throw new Error('This channel is not a Silena ticket.');

    const messages = [];
    let before;
    while (messages.length < MAX_TRANSCRIPT_MESSAGES) {
        const limit = Math.min(PAGE_SIZE, MAX_TRANSCRIPT_MESSAGES - messages.length);
        const page = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
        const pageMessages = [...page.values()];
        if (!pageMessages.length) break;

        messages.push(...pageMessages);
        if (pageMessages.length < limit) break;
        before = pageMessages[pageMessages.length - 1].id;
    }

    messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
    const header = [
        `Silena ticket transcript`,
        `Channel: #${channel.name} (${channel.id})`,
        `Ticket opener ID: ${ticket.openerId}`,
        `Closed by: ${closedBy.tag || closedBy.username} (${closedBy.id})`,
        `Closed at: ${closedAt.toISOString()}`,
        `Close reason: ${closeReason}`,
        '',
        'Messages (oldest first):',
        ''
    ].join('\n');
    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (headerBytes >= MAX_TRANSCRIPT_BYTES) throw new Error('Ticket transcript header exceeds the attachment size limit.');

    let transcript = header;
    let includedMessages = 0;
    let omittedMessages = 0;
    for (const message of messages) {
        const line = messageToTranscriptLine(message);
        if (Buffer.byteLength(transcript, 'utf8') + Buffer.byteLength(line, 'utf8') > MAX_TRANSCRIPT_CONTENT_BYTES) {
            omittedMessages += 1;
            continue;
        }
        transcript += `${line}\n`;
        includedMessages += 1;
    }

    const truncatedByFetchLimit = messages.length === MAX_TRANSCRIPT_MESSAGES;
    if (omittedMessages || truncatedByFetchLimit) {
        transcript += `\n[Transcript truncated: ${omittedMessages} message(s) omitted due to the 7 MiB attachment limit. The history scan was also capped at ${MAX_TRANSCRIPT_MESSAGES} messages${truncatedByFetchLimit ? '; older messages may not be included' : ''}.]\n`;
    }

    return {
        buffer: Buffer.from(transcript, 'utf8'),
        filename: `ticket-${channel.id}-transcript.txt`,
        messageCount: messages.length,
        includedMessages,
        omittedMessages,
        scanLimitReached: truncatedByFetchLimit
    };
}

function parseTicketTopic(topic) {
    const match = /^silena-ticket:v1:(open|closed):(\d{17,20})$/.exec(topic || '');
    if (!match) return null;
    return { status: match[1], openerId: match[2] };
}

async function archiveTicketTranscript(channel, archiveChannel, closeDetails) {
    if (!archiveChannel?.send || typeof archiveChannel.isTextBased !== 'function' || !archiveChannel.isTextBased()) {
        throw new Error('Configured ticket archive channel is unavailable or is not a text channel.');
    }
    if (archiveChannel.guildId !== channel.guildId) {
        throw new Error('Configured ticket archive channel must belong to the configured server.');
    }

    const transcript = await buildTicketTranscript(channel, closeDetails);
    const message = await archiveChannel.send({
        content: `Archived ticket <#${channel.id}>. Closed by ${closeDetails.closedBy.tag || closeDetails.closedBy.username}. Reason: ${closeDetails.closeReason}`,
        allowedMentions: { parse: [] },
        files: [{
            attachment: transcript.buffer,
            name: transcript.filename
        }]
    });

    return { message, ...transcript };
}

module.exports = {
    MAX_TRANSCRIPT_BYTES,
    MAX_TRANSCRIPT_MESSAGES,
    archiveTicketTranscript,
    buildTicketTranscript
};
