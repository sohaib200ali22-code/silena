const MAX_TRANSCRIPT_BYTES = 7 * 1024 * 1024;
const MAX_TRANSCRIPT_CONTENT_BYTES = MAX_TRANSCRIPT_BYTES - 512;
const MAX_TRANSCRIPT_MESSAGES = 10000;
const PAGE_SIZE = 100;
const DOWNLOAD_TIMEOUT_MS = 8_000;

async function fetchAttachmentData(attachment) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(attachment.url, { signal: controller.signal });
        if (!response.ok) return `[attachment failed to download: ${attachment.url}]`;

        const contentType = response.headers.get('content-type') || '';
        
        // لو الملف نصي أو كود: نطبع محتواه جوه الملف
        if (contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript')) {
            const text = await response.text();
            const safeText = text.length > 4000 ? text.slice(0, 4000) + '\n...[content truncated]' : text;
            return `[attached text file: ${attachment.name}]\n\`\`\`\n${safeText}\n\`\`\``;
        }

        // لو صورة أو ميديا: نحفظ الـ Base64 Data URI
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64 = buffer.toString('base64');
        return `[attached file: ${attachment.name} (data:${contentType};base64,${base64.slice(0, 100)}... truncated data uri)]\nOriginal URL: ${attachment.url}`;
    } catch {
        return `[attachment download timeout: ${attachment.url}]`;
    } finally {
        clearTimeout(timeout);
    }
}

async function messageToTranscriptLine(message) {
    const timestamp = message.createdAt?.toISOString?.() ||
        new Date(message.createdTimestamp).toISOString();
    const author = `${message.author.tag || message.author.username} (${message.author.id})`;
    const content = (message.content || '').replace(/\r\n/g, '\n');

    const attachmentLines = [];
    if (message.attachments?.size) {
        for (const attachment of message.attachments.values()) {
            const downloadedData = await fetchAttachmentData(attachment);
            attachmentLines.push(downloadedData);
        }
    }

    const embeds = message.embeds.map(embed => embed.url).filter(Boolean);
    const extra = [
        ...attachmentLines,
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
    if (headerBytes >= MAX_TRANSCRIPT_BYTES) throw new Error('Ticket transcript header exceeds limit.');

    let transcript = header;
    let includedMessages = 0;
    let omittedMessages = 0;

    for (const message of messages) {
        const line = await messageToTranscriptLine(message);
        if (Buffer.byteLength(transcript, 'utf8') + Buffer.byteLength(line, 'utf8') > MAX_TRANSCRIPT_CONTENT_BYTES) {
            omittedMessages += 1;
            continue;
        }
        transcript += `${line}\n`;
        includedMessages += 1;
    }

    const truncatedByFetchLimit = messages.length === MAX_TRANSCRIPT_MESSAGES;
    if (omittedMessages || truncatedByFetchLimit) {
        transcript += `\n[Transcript truncated: ${omittedMessages} message(s) omitted due to size limit.]\n`;
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
