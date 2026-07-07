import { ConnectionOptions } from 'bullmq';

export function parseRedisConnection(redisUrl: string): ConnectionOptions {
  const parsedUrl = new URL(redisUrl);
  const database = parsedUrl.pathname.replace('/', '');

  return {
    host: parsedUrl.hostname,
    port: Number(parsedUrl.port || 6379),
    username: parsedUrl.username
      ? decodeURIComponent(parsedUrl.username)
      : undefined,
    password: parsedUrl.password
      ? decodeURIComponent(parsedUrl.password)
      : undefined,
    db: database ? Number(database) : undefined,
    tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
