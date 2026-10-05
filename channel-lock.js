async function setChannelLocked(channel, locked, reason) {
    if (typeof locked !== 'boolean') {
        throw new TypeError('locked must be a boolean.');
    }
    if (
        !channel?.permissionOverwrites?.edit ||
        !channel.guild?.roles?.everyone ||
        typeof channel.isTextBased !== 'function' ||
        !channel.isTextBased() ||
        (typeof channel.isVoiceBased === 'function' && channel.isVoiceBased()) ||
        (typeof channel.isThread === 'function' && channel.isThread())
    ) {
        throw new Error('This command requires a text channel with permission overwrites; threads and voice channels are unsupported.');
    }

    await channel.permissionOverwrites.edit(
        channel.guild.roles.everyone,
        { SendMessages: locked ? false : null },
        { reason }
    );
}

module.exports = { setChannelLocked };
