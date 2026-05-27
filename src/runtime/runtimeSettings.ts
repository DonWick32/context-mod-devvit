import { settings } from '@devvit/web/server';
import type { ActionRuntimeSettings } from './actionExecutor';
import {
  normalizeModerationScanIntervalMinutes,
  normalizeModerationScanLimit,
  type ModerationScanRuntimeSettings,
} from './moderationScanProcessor';

type SettingsReader = Pick<typeof settings, 'get'>;

export const loadActionRuntimeSettings = async (
  settingsReader: SettingsReader = settings
): Promise<ActionRuntimeSettings> => {
  const youtubeApiKey = await settingsReader.get<string>('youtubeApiKey');
  const geminiApiKey = await settingsReader.get<string>('geminiApiKey');
  return {
    appEnabled: (await settingsReader.get<boolean>('enabled')) === true,
    dryRun: (await settingsReader.get<boolean>('dryRun')) !== false,
    ...(youtubeApiKey ? { youtubeApiKey } : {}),
    ...(geminiApiKey ? { geminiApiKey } : {}),
  };
};

export const isEventProcessingEnabled = async (
  settingsReader: SettingsReader = settings
): Promise<boolean> => (await settingsReader.get<boolean>('enabled')) === true;

export const loadModerationScanRuntimeSettings = async (
  settingsReader: SettingsReader = settings
): Promise<ModerationScanRuntimeSettings> => ({
  limit: normalizeModerationScanLimit(
    await settingsReader.get<number>('moderationScanLimit')
  ),
  intervalMinutes: normalizeModerationScanIntervalMinutes(
    await settingsReader.get<number>('moderationScanIntervalMinutes')
  ),
});
