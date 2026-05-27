import type { RedisClient } from '@devvit/web/server';
import type { ActivitySnapshot } from './activityAdapter';

export type ReportHistoryRecord = {
  type: 'user' | 'mod';
  reason: string;
  timestamp: number;
};

const getReportHistoryKey = (activityId: string) => `cm:reps:${activityId}`;

export const getReportHistory = async (
  redis: Pick<RedisClient, 'get'>,
  activityId: string
): Promise<ReportHistoryRecord[]> => {
  const data = await redis.get(getReportHistoryKey(activityId));
  if (!data) return [];
  try {
    return JSON.parse(data);
  } catch {
    return [];
  }
};

export const saveReportHistory = async (
  redis: Pick<RedisClient, 'get' | 'set' | 'expire'>,
  activity: ActivitySnapshot
): Promise<ReportHistoryRecord[]> => {
  const userReasons = activity.userReportReasons ?? [];
  const modReasons = activity.modReportReasons ?? [];
  
  const existing = await getReportHistory(redis, activity.id);

  if (userReasons.length === 0 && modReasons.length === 0) {
    return existing;
  }

  const now = Date.now();
  let changed = false;
  const records = [...existing];

  const processReasons = (reasons: string[], type: 'user' | 'mod') => {
    const reasonCounts = new Map<string, number>();
    for (const reason of reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    
    for (const [reason, count] of reasonCounts.entries()) {
      const existingCount = records.filter(r => r.type === type && r.reason === reason).length;
      if (count > existingCount) {
        for (let i = 0; i < count - existingCount; i++) {
          records.push({ type, reason, timestamp: now });
          changed = true;
        }
      }
    }
  };

  processReasons(userReasons, 'user');
  processReasons(modReasons, 'mod');

  if (changed) {
    const key = getReportHistoryKey(activity.id);
    await redis.set(key, JSON.stringify(records));
    // Expire in 6 months
    await redis.expire(key, 6 * 30 * 24 * 60 * 60);
  }

  return records;
};
