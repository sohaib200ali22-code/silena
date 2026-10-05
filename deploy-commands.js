require('dotenv').config();

const { readConfig } = require('./config');
const { registerGuildCommands } = require('./register-commands');

async function deployCommands() {
    const config = readConfig(process.env);
    const result = await registerGuildCommands(config);
    console.info(`Registered ${result.count} Silena commands for guild ${result.guildId}.`);
}

deployCommands().catch(error => {
    console.error('Failed to register Silena commands:', error);
    process.exitCode = 1;
});
