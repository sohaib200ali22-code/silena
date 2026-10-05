const { REST, Routes } = require('discord.js');
const { createCommandDefinitions } = require('./commands');

async function registerGuildCommands({ token, clientId, guildId }, restClient) {
    const rest = restClient || new REST({ version: '10' }).setToken(token);
    const commands = createCommandDefinitions().map(command => command.toJSON());

    await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
    );

    return { count: commands.length, guildId };
}

module.exports = { registerGuildCommands };
