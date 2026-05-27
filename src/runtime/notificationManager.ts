import { DiscordNotifier, type NotificationContent } from './discordNotifier';
import type { NormalizedConfig, UnknownRecord } from '../config/legacyTypes';

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class NotificationManager {
  private discordNotifiers: Map<string, DiscordNotifier> = new Map();

  constructor(normalizedConfig: NormalizedConfig | UnknownRecord | undefined) {
    const candidate: UnknownRecord | undefined = isRecord(normalizedConfig)
      ? normalizedConfig
      : undefined;
    const config =
      candidate !== undefined && isRecord(candidate.config)
        ? candidate.config
        : candidate;
    if (!isRecord(config) || !isRecord(config.notifications)) {
      return;
    }

    const providers = config.notifications.providers;
    if (!Array.isArray(providers)) {
      return;
    }

    const botName =
      typeof config.botName === 'string' ? config.botName : 'ContextMod';
    console.log(`Found ${providers.length} notification providers in config`);
    for (const provider of providers) {
      if (
        isRecord(provider) &&
        provider.type === 'discord' &&
        typeof provider.name === 'string' &&
        typeof provider.url === 'string'
      ) {
        this.discordNotifiers.set(
          provider.name,
          new DiscordNotifier(provider.name, botName, provider.url)
        );
      }
    }
  }

  async send(
    content: NotificationContent,
    providerName?: string
  ): Promise<void> {
    const promises: Promise<void>[] = [];
    if (providerName !== undefined) {
      const notifier = this.discordNotifiers.get(providerName);
      if (notifier) {
        promises.push(notifier.handle(content));
      }
    } else {
      for (const notifier of this.discordNotifiers.values()) {
        promises.push(notifier.handle(content));
      }
    }
    await Promise.allSettled(promises);
  }
}
