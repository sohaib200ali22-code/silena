require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { readConfig } = require('./config');
const { createCommandDefinitions } = require('./commands');

async function deployCommands() {
    const config = readConfig(process.env);
    const rest = new REST({ version: '10' }).setToken(config.token);
    const commands = createCommandDefinitions().map(command => command.toJSON());

    await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands }
    );
    console.log(`Registered ${commands.length} Silena commands for guild ${config.guildId}.`);
}

deployCommands().catch(error => {
    console.error('Failed to register Silena commands:', error);
    process.exitCode = 1;
});
