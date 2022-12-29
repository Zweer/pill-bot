/* eslint-disable id-length */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyHandler } from 'aws-lambda';
import { Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';

// eslint-disable-next-line no-process-env
const token = process.env.BOT_TOKEN as string;
const bot = new Telegraf(token);

// eslint-disable-next-line no-process-env
const usersTable = process.env.USERS_TABLE as string;
const dynamo = new DynamoDBClient({});

bot.on(message('text'), async (ctx, next) => {
  const id = ctx.chat.id;

  const getUserCommand = new GetItemCommand({
    TableName: usersTable,
    Key: {
      id: {
        N: id.toString(),
      },
    },
  });

  const getUserOutput = await dynamo.send(getUserCommand);
  if (!getUserOutput.Item) {
    const putUserCommand = new PutItemCommand({
      TableName: usersTable,
      Item: {
        id: { N: id.toString() },
        name: { S: ctx.message.from.first_name },
      },
    });

    await dynamo.send(putUserCommand);

    return ctx.reply(
      `Nice to meet you ${ctx.message.from.first_name}, when do you want to be notified?`,
      Markup.keyboard(
        [...Array(24).keys()].map((i) => `${i}`),
        {
          wrap: (_, index, currentRow) => currentRow.length > index % 4,
        },
      ),
    );
  }

  // eslint-disable-next-line require-atomic-updates
  ctx.state.user = getUserOutput.Item;

  return next();
});

bot.on(message('text'), async (ctx, next) => {
  const { user } = ctx.state;

  if (!user.alertAt) {
    const putUserCommand = new PutItemCommand({
      TableName: usersTable,
      Item: {
        id: { N: ctx.chat.id.toString() },
        name: { S: ctx.message.from.first_name },
        alertAt: { N: ctx.message.text },
        alert: { BOOL: true },
      },
    });

    await dynamo.send(putUserCommand);

    return ctx.reply(`Perfect! You'll be notified at ${ctx.message.text}`);
  }

  await ctx.reply(`Hi ${user.name.S}, you'll be notified at ${user.alertAt.N}!`);

  return next();
});

export const handler: APIGatewayProxyHandler = async (event) => {
  const { body } = event;
  const data = JSON.parse(body as string);

  await bot.handleUpdate(data);

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true }),
  };
};
