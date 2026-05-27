export type NotificationContent = {
  logLevel: 'error' | 'warn' | 'info';
  title: string;
  body?: string;
  footer?: string;
};

export class DiscordNotifier {
  name: string;
  botName: string;
  url: string;

  constructor(name: string, botName: string, url: string) {
    this.name = name;
    this.botName = botName;
    this.url = url;
  }

  async handle(val: NotificationContent): Promise<void> {
    console.log(`Sending Discord webhook to ${this.name}...`);
    const { logLevel, title, footer, body = '' } = val;

    let color = 0x00fffa;
    if (logLevel === 'error') {
      color = 0xff0000;
    } else if (logLevel === 'warn') {
      color = 0xffe900;
    }

    const payload = {
      username: this.botName === 'ContextMod' ? 'ContextMod' : `(ContextMod) ${this.botName}`,
      embeds: [
        {
          title,
          description: body,
          color,
          ...(footer !== undefined ? { footer: { text: footer } } : {}),
        },
      ],
    };

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(
          `Failed to send Discord webhook ${this.name}: ${response.status} ${response.statusText}. Response: ${text}`
        );
      }
    } catch (error) {
      console.error(
        `Error sending Discord webhook ${this.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
