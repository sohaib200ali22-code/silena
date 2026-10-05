const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function requiredValue(env, name) {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} must be set.`);
    return value;
}

function readBoolean(env, name, defaultValue) {
    const value = env[name];
    if (value === undefined || value.trim() === '') return defaultValue;
    if (value.trim().toLowerCase() === 'true') return true;
    if (value.trim().toLowerCase() === 'false') return false;
    throw new Error(`${name} must be either "true" or "false".`);
}

function readInteger(env, name, defaultValue, minimum, maximum) {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
    if (!/^\d+$/.test(rawValue.trim())) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }

    const value = Number(rawValue);
    if (value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
}

function readConfig(env) {
    const token = requiredValue(env, 'DISCORD_TOKEN');
    const clientId = requiredValue(env, 'CLIENT_ID');
    const guildId = requiredValue(env, 'GUILD_ID');
    const ownerId = requiredValue(env, 'OWNER_ID');
    const staffRoleId = requiredValue(env, 'STAFF_ROLE_ID');
    const ticketsChannelId = requiredValue(env, 'TICKETS_CHANNEL_ID');
    const logsChannelId = requiredValue(env, 'LOGS_CHANNEL_ID');

    const ids = {
        CLIENT_ID: clientId,
        GUILD_ID: guildId,
        OWNER_ID: ownerId,
        STAFF_ROLE_ID: staffRoleId,
        TICKETS_CHANNEL_ID: ticketsChannelId,
        LOGS_CHANNEL_ID: logsChannelId
    };
    if (logsChannelId) ids.LOGS_CHANNEL_ID = logsChannelId;
    for (const [name, value] of Object.entries(ids)) {
        if (!SNOWFLAKE_PATTERN.test(value)) {
            throw new Error(`${name} must be a Discord ID (17-20 digits).`);
        }
    }

    return {
        token,
        clientId,
        guildId,
        ownerId,
        staffRoleId,
        ticketsChannelId,
        logsChannelId,
        blockInvites: readBoolean(env, 'BLOCK_INVITES', true),
        blockLinks: readBoolean(env, 'BLOCK_LINKS', false),
        spamMaxMessages: readInteger(env, 'SPAM_MAX_MESSAGES', 5, 3, 20),
        spamWindowSeconds: readInteger(env, 'SPAM_WINDOW_SECONDS', 8, 3, 60)
    };
}

module.exports = { readConfig };
