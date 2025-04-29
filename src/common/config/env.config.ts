import { config } from 'dotenv';
import { cleanEnv, num, str } from 'envalid';

config();

export const env = cleanEnv(process.env, {
  PORT: num({ default: 3000, example: '3000' }),
  NODE_ENV: str({ choices: ['development', 'test', 'production'] }),
  API_HOST: str({ default: 'localhost' }),
  MINIO_ACCESS_KEY: str(),
  MINIO_ENDPOINT: str(),
  MINIO_PORT: str(),
  MINIO_SECRET_KEY: str(),
  MINIO_BUCKET: str(),
  BOT_TOKEN: str(),
  REJECTED_MESSAGE_TIMEOUT_IN_MINUTES: num({ default: 30 }),
  FIND_FREE_OPERATORS_CRON_PATTERN: str({ default: '*/1 * * * *' }),

  STREAM_API_KEY: str(),
  STREAM_SECRET: str(),

  JWT_SECRET: str(),
  JWT_SECRET_DOCTOR: str(),
});
