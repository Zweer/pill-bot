import { Telegraf } from 'telegraf';

// eslint-disable-next-line no-process-env
const token = process.env.BOT_TOKEN as string;
const bot = new Telegraf(token);

export const handler = async ({ message, id }: { message: string; id: number }) => {
  await bot.telegram.sendMessage(id, Array.isArray(message) ? message.join('\n') : message);
};
