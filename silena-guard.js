const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { randomUUID } = require('node:crypto');

const ACCOUNT_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 15 * 60 * 1000;
const CONFIRMATION_STEPS = [
    {
        label: '1/3 - I understand the account-age rule',
        style: ButtonStyle.Secondary,
        text: 'Step 1 of 3: accounts created less than 7 days ago will be kicked when they join. Established accounts, bots, the server owner, administrators, and the configured bot owner are exempt.'
    },
    {
        label: '2/3 - Confirm moderation behavior',
        style: ButtonStyle.Secondary,
        text: 'Step 2 of 3: Silena will also delete configured invite/link violations and mass mentions. A spam burst above your configured threshold will have its messages deleted and trigger a 1-hour timeout when Silena has permission and role hierarchy allows it.'
    },
    {
        label: '3/3 - Enable Silena Guard',
        style: ButtonStyle.Danger,
        text: 'Final step: click to enable these protections for this process. This does not persist across a bot restart.'
    }
];

function isAccountYoungerThanLimit(createdTimestamp, now = Date.now()) {
    return Number.isFinite(createdTimestamp) && now - createdTimestamp < ACCOUNT_AGE_LIMIT_MS;
}

function createSilenaGuard({
    client,
    config,
    logEvent,
    reportError,
    notifyModerationTarget,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    let enabledAt = null;
    let enabledBy = null;
    const confirmations = new Map();
    const processingJoins = new Set();

    function clearConfirmation(id) {
        const pending = confirmations.get(id);
        if (!pending) return;
        clearTimer(pending.expiryTimer);
        confirmations.delete(id);
    }

    function clearAllConfirmations() {
        for (const id of confirmations.keys()) clearConfirmation(id);
    }

    function isAuthorized(interaction) {
        return interaction.inGuild() &&
            interaction.guildId === config.guildId &&
            interaction.user.id === config.ownerId;
    }

    function hasKickPermission(interaction) {
        return Boolean(interaction.appPermissions?.has(PermissionFlagsBits.KickMembers));
    }

    function confirmationButton(id, step) {
        const confirmation = CONFIRMATION_STEPS[step];
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`silena-guard:confirm:${id}:${step + 1}`)
                .setLabel(confirmation.label)
                .setStyle(confirmation.style)
        );
    }

    async function deny(interaction, content) {
        return interaction.reply({ content, ephemeral: true });
    }

    async function startEnable(interaction) {
        if (enabledAt !== null) {
            return deny(interaction, 'Silena Guard is already enabled. Use `/silena status` to review it or `/silena disable` to turn it off.');
        }
        if (!hasKickPermission(interaction)) {
            return deny(interaction, 'Silena needs Kick Members permission in this server before Guard can be enabled.');
        }

        const id = randomUUID();
        const expiryTimer = setTimer(() => confirmations.delete(id), CONFIRMATION_TTL_MS);
        expiryTimer.unref?.();
        confirmations.set(id, {
            ownerId: interaction.user.id,
            guildId: interaction.guildId,
            step: 0,
            expiryTimer
        });
        return interaction.reply({
            content: `Silena Guard is **OFF**. ${CONFIRMATION_STEPS[0].text}\n\nThis starts a three-step confirmation. Protections remain off until the third button is pressed.`,
            components: [confirmationButton(id, 0)],
            ephemeral: true
        });
    }

    async function handleCommand(interaction) {
        if (!isAuthorized(interaction)) {
            return deny(interaction, 'Only the configured bot owner can control Silena Guard.');
        }

        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'enable') return startEnable(interaction);
        if (subcommand === 'status') {
            const status = enabledAt === null
                ? 'OFF'
                : `ON since <t:${Math.floor(enabledAt / 1000)}:F>`;
            return deny(interaction, `Silena Guard is **${status}**. Guard state resets to OFF whenever the bot process restarts.`);
        }
        if (subcommand === 'disable') {
            const wasEnabled = enabledAt !== null;
            enabledAt = null;
            enabledBy = null;
            clearAllConfirmations();
            if (wasEnabled) {
                logEvent('silena_guard_disabled', {
                    guildId: config.guildId,
                    actorId: interaction.user.id
                });
            }
            return deny(interaction, wasEnabled
                ? 'Silena Guard is now **OFF**. Guard automod and new-account kicks are disabled.'
                : 'Silena Guard is already **OFF**.');
        }
        return deny(interaction, 'Unknown Silena Guard action.');
    }

    async function handleButton(interaction) {
        const match = /^silena-guard:confirm:([0-9a-f-]{36}):([1-3])$/.exec(interaction.customId);
        if (!match) return false;
        const [, id, stepText] = match;
        const confirmation = confirmations.get(id);
        if (!confirmation) {
            await deny(interaction, 'This three-step confirmation expired. Run `/silena enable` to start again.');
            return true;
        }
        if (
            !isAuthorized(interaction) ||
            confirmation.ownerId !== interaction.user.id ||
            confirmation.guildId !== interaction.guildId
        ) {
            await deny(interaction, 'Only the configured bot owner can confirm Silena Guard.');
            return true;
        }
        const step = Number(stepText) - 1;
        if (step !== confirmation.step) {
            await deny(interaction, 'That confirmation step is stale or out of order. Use the latest button.');
            return true;
        }

        if (step < CONFIRMATION_STEPS.length - 1) {
            confirmation.step += 1;
            await interaction.update({
                content: CONFIRMATION_STEPS[confirmation.step].text,
                components: [confirmationButton(id, confirmation.step)]
            });
            return true;
        }

        if (enabledAt !== null) {
            clearConfirmation(id);
            await deny(interaction, 'Silena Guard was enabled by another confirmation. No additional action was taken.');
            return true;
        }
        if (!hasKickPermission(interaction)) {
            clearConfirmation(id);
            await deny(interaction, 'Silena no longer has Kick Members permission. Guard was not enabled.');
            return true;
        }

        enabledAt = now();
        enabledBy = interaction.user.id;
        clearConfirmation(id);
        logEvent('silena_guard_enabled', {
            guildId: config.guildId,
            actorId: enabledBy,
            accountAgeLimitDays: 7
        });
        await interaction.update({
            content: 'Silena Guard is now **ON**. Accounts younger than 7 days will be kicked on join, configured invite/link and mass-mention violations will be deleted, and spam bursts will be deleted with an attempted 1-hour timeout. No automatic ban is enabled.',
            components: []
        });
        return true;
    }

    async function handleMemberJoin(member) {
        if (
            enabledAt === null ||
            member.guild.id !== config.guildId ||
            member.user.bot ||
            member.user.id === config.ownerId ||
            member.id === member.guild.ownerId ||
            member.permissions?.has(PermissionFlagsBits.Administrator) ||
            !isAccountYoungerThanLimit(member.user.createdTimestamp, now())
        ) return false;

        const joinKey = `${member.guild.id}:${member.id}`;
        if (processingJoins.has(joinKey)) return false;
        processingJoins.add(joinKey);
        const reason = 'Silena Guard: account is less than 7 days old.';
        try {
            if (!member.kickable) {
                reportError(`Silena Guard could not kick young account ${member.id}`, new Error('Member is not kickable due to permissions or role hierarchy.'));
                logEvent('silena_guard_kick_failed', {
                    guildId: member.guild.id,
                    userId: member.id,
                    reason: 'not_kickable'
                });
                return false;
            }

            await member.kick(reason);
            logEvent('silena_guard_young_account_kicked', {
                guildId: member.guild.id,
                userId: member.id,
                accountCreatedAt: member.user.createdTimestamp,
                accountAgeLimitDays: 7
            });
            await notifyModerationTarget({
                user: member.user,
                guildId: member.guild.id,
                guildName: member.guild.name,
                action: 'kick',
                reason,
                logEvent,
                reportError
            });
            return true;
        } catch (error) {
            reportError(`Silena Guard could not kick young account ${member.id}`, error);
            logEvent('silena_guard_kick_failed', {
                guildId: member.guild.id,
                userId: member.id,
                reason: error.message
            });
            return false;
        } finally {
            processingJoins.delete(joinKey);
        }
    }

    return {
        handleButton,
        handleCommand,
        handleMemberJoin,
        isEnabled: () => enabledAt !== null
    };
}

module.exports = {
    ACCOUNT_AGE_LIMIT_MS,
    CONFIRMATION_STEPS,
    CONFIRMATION_TTL_MS,
    createSilenaGuard,
    isAccountYoungerThanLimit
};
