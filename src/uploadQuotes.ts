/* eslint-disable id-length */
import { createHash } from 'crypto';

import { BatchWriteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';
import axios from 'axios';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const loveQuotes = require('./quotes/love.json');

// eslint-disable-next-line no-process-env
const quotesTable = process.env.QUOTES_TABLE as string;
const dynamo = new DynamoDBClient({});

const chunkArray = (array: string[], chunkSize = 25) =>
  Array(Math.ceil(array.length / chunkSize))
    .fill(null)
    .map((_, index) => index * chunkSize)
    .map((begin) => array.slice(begin, begin + chunkSize));

const writeQuotes = async (array: string[], type: string) =>
  chunkArray(array).reduce(async (promise, quotes) => {
    await promise;

    const batchWriteItemCommand = new BatchWriteItemCommand({
      RequestItems: {
        [quotesTable]: quotes.map((quote) => ({
          PutRequest: {
            Item: {
              id: { S: createHash('sha256').update(quote).digest('hex') },
              type: { S: type },
              text: { S: quote },
            },
          },
        })),
      },
    });

    await dynamo.send(batchWriteItemCommand);
  }, Promise.resolve());

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  await writeQuotes(loveQuotes, 'love');

  const data: CloudFormationCustomResourceResponse = {
    LogicalResourceId: event.LogicalResourceId,
    PhysicalResourceId: event.RequestType === 'Create' ? event.RequestId : event.PhysicalResourceId,
    RequestId: event.RequestId,
    StackId: event.StackId,
    Status: 'SUCCESS',
  };

  await axios.put(event.ResponseURL, data);
};
