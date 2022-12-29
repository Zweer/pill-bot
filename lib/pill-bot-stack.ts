/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable id-length */
import { join } from 'path';

import {
  CustomResource,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import { LambdaIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  JsonPath,
  Map,
  Pass,
  Result,
  StateMachine,
  TaskInput,
} from 'aws-cdk-lib/aws-stepfunctions';
import { CallAwsService, LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class PillBotStack extends Stack {
  private static readonly PROJECT_NAME = 'pillBot';

  // eslint-disable-next-line no-process-env
  private static readonly BOT_TOKEN = process.env.BOT_TOKEN as string;

  private usersTable: Table;

  private quotesTable: Table;

  private sendMessageFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.createCommonResources();
    this.createFunctions();
    this.createScheduledJob();
  }

  private createCommonResources() {
    this.usersTable = new Table(this, 'UsersTable', {
      partitionKey: {
        name: 'id',
        type: AttributeType.NUMBER,
      },
      tableName: `${PillBotStack.PROJECT_NAME}.users`,
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.quotesTable = new Table(this, 'QuotesTable', {
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING,
      },
      tableName: `${PillBotStack.PROJECT_NAME}.quotes`,
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  private createScheduledJob() {
    const retrieveUsersJob = new CallAwsService(this, 'RetrieveUsersScheduled', {
      service: 'dynamodb',
      action: 'scan',
      parameters: {
        TableName: this.usersTable.tableName,
        FilterExpression: 'alertAt = :alertAt AND alert = :alert',
        ExpressionAttributeValues: {
          ':alertAt': {
            N: JsonPath.arrayGetItem(
              JsonPath.stringSplit(
                JsonPath.arrayGetItem(
                  JsonPath.stringSplit(JsonPath.stringAt('$$.Execution.StartTime'), 'T'),
                  1,
                ),
                ':',
              ),
              0,
            ),
          },
          ':alert': {
            Bool: true,
          },
        },
      },
      iamResources: [this.usersTable.tableArn],
      resultSelector: {
        users: JsonPath.listAt('$.Items'),
      },
    });

    const retrieveRandomQuoteJob = new CallAwsService(this, 'RetrieveRandomQuoteJob', {
      service: 'dynamodb',
      action: 'scan',
      parameters: {
        TableName: this.quotesTable.tableName,
        Limit: 1,
        ExclusiveStartKey: {
          id: {
            S: JsonPath.hash(JsonPath.stringAt('$$.Execution.StartTime'), 'SHA-256'),
          },
        },
      },
      iamResources: [this.quotesTable.tableArn],
      resultPath: '$.quote',
      resultSelector: {
        text: JsonPath.objectAt('$.Items[0].text.S'),
        id: JsonPath.objectAt('$.Items[0].id.S'),
        type: JsonPath.objectAt('$.Items[0].type.S'),
      },
    }).addRetry();

    const definition = retrieveUsersJob.next(
      new Map(this, 'UsersMapJob', {
        itemsPath: '$.users',
        parameters: {
          user: {
            alertAt: JsonPath.numberAt('$$.Map.Item.Value.alertAt.N'),
            alert: JsonPath.numberAt('$$.Map.Item.Value.alert.Bool'),
            name: JsonPath.numberAt('$$.Map.Item.Value.name.S'),
            id: JsonPath.numberAt('$$.Map.Item.Value.id.N'),
          },
        },
      }).iterator(
        retrieveRandomQuoteJob.next(
          new Pass(this, 'CreateMessageJob', {
            parameters: {
              user: JsonPath.objectAt('$.user'),
              quote: JsonPath.objectAt('$.quote'),
              message: JsonPath.array(
                JsonPath.format('Hi {}!', JsonPath.stringAt('$.user.name')),
                'Remember to take the pill!',
                JsonPath.stringAt('$.quote.text'),
              ),
            },
          }).next(
            new LambdaInvoke(this, 'SendMessageJob', {
              lambdaFunction: this.sendMessageFunction,
              payload: TaskInput.fromObject({
                id: JsonPath.numberAt('$.user.id'),
                message: JsonPath.listAt('$.message'),
              }),
            }),
          ),
        ),
      ),
    );

    const stateMachine = new StateMachine(this, 'ScheduledAction', {
      stateMachineName: `${PillBotStack.PROJECT_NAME}.scheduled`,
      definition,
    });

    const rule = new Rule(this, 'ScheduledActionRule', {
      ruleName: `${PillBotStack.PROJECT_NAME}.scheduled`,
      schedule: Schedule.cron({
        minute: '0',
      }),
      targets: [new SfnStateMachine(stateMachine)],
    });
  }

  private createFunctions() {
    const commonNodejsFunctionProps: NodejsFunctionProps = {
      runtime: Runtime.NODEJS_18_X,
      depsLockFilePath: join(__dirname, '..', 'package-lock.json'),
      timeout: Duration.seconds(10),
      tracing: Tracing.ACTIVE,
      environment: {
        BOT_TOKEN: PillBotStack.BOT_TOKEN,
        QUOTES_TABLE: this.quotesTable.tableName,
        USERS_TABLE: this.usersTable.tableName,
      },
    };

    const handleRequestsFunction = new NodejsFunction(this, 'HandleRequestsFunction', {
      ...commonNodejsFunctionProps,
      functionName: `${PillBotStack.PROJECT_NAME}-handleRequests`,
      entry: join(__dirname, '..', 'src', 'handleRequests.ts'),
    });
    this.usersTable.grantReadWriteData(handleRequestsFunction);

    this.sendMessageFunction = new NodejsFunction(this, 'SendMessageFunction', {
      ...commonNodejsFunctionProps,
      functionName: `${PillBotStack.PROJECT_NAME}-sendMessage`,
      entry: join(__dirname, '..', 'src', 'sendMessage.ts'),
    });

    const registerWebhookFunction = new NodejsFunction(this, 'RegisterWebhookFunction', {
      ...commonNodejsFunctionProps,
      functionName: `${PillBotStack.PROJECT_NAME}-registerWebhook`,
      entry: join(__dirname, '..', 'src', 'registerWebhook.ts'),
    });

    const uploadQuotesFunction = new NodejsFunction(this, 'UploadQuotesFunction', {
      ...commonNodejsFunctionProps,
      functionName: `${PillBotStack.PROJECT_NAME}-uploadQuotes`,
      entry: join(__dirname, '..', 'src', 'uploadQuotes.ts'),
    });
    this.quotesTable.grantWriteData(uploadQuotesFunction);

    const api = new RestApi(this, 'Api', {
      restApiName: PillBotStack.PROJECT_NAME,
      deployOptions: {
        tracingEnabled: true,
      },
    });

    const telegrafPath = 'telegraf';
    api.root
      .addResource(telegrafPath)
      .addMethod('POST', new LambdaIntegration(handleRequestsFunction));

    const registerWebhookProvider = new Provider(this, 'RegisterWebhookProvider', {
      providerFunctionName: `${PillBotStack.PROJECT_NAME}-provider-registerWebhook`,
      onEventHandler: registerWebhookFunction,
    });

    const registerWebhookCustomResource = new CustomResource(
      this,
      'RegisterWebhookCustomResource',
      {
        serviceToken: registerWebhookProvider.serviceToken,
        properties: {
          endpoint: api.urlForPath(`/${telegrafPath}`),
        },
      },
    );

    const uploadQuotesProvider = new Provider(this, 'UploadQuotesProvider', {
      onEventHandler: uploadQuotesFunction,
      providerFunctionName: `${PillBotStack.PROJECT_NAME}-provider-uploadQuotes`,
    });

    const uploadQuotesCustomResource = new CustomResource(this, 'UploadQuotesCustomResource', {
      serviceToken: uploadQuotesProvider.serviceToken,
    });
  }
}
