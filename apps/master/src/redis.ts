import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function createRedis(url: string, connectionName = 'remyral-master'): Redis {
  const redis = new Redis(url, {
    connectionName,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    // Fail commands fast while disconnected instead of queueing them (readiness and rate limits must
    // see the outage, not hang).
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  // Connection errors are surfaced by commands / readiness; never let them crash the process.
  redis.on('error', () => undefined);
  return redis;
}
