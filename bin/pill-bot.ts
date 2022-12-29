import 'source-map-support/register';
import { App } from 'aws-cdk-lib';

import { PillBotStack } from '../lib/pill-bot-stack';

const app = new App();
const stack = new PillBotStack(app, 'PillBotStack');
