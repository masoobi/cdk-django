import * as fs from 'fs';
import { App, Stack, Tags } from 'aws-cdk-lib';
import { AdHocApp } from '../../constructs/ad-hoc/app';
import { AdHocBase } from '../../constructs/ad-hoc/base';

const adHocBaseEnvName = process.env.AD_HOC_BASE_NAME || 'dev';
const adHocAppEnvName = process.env.AD_HOC_APP_NAME || 'alpha';

// TODO: define interfaces for these config and type check them
var adHocBaseEnvConfig = JSON.parse(fs.readFileSync(`src/examples/ad-hoc/config/${adHocBaseEnvName}.json`, 'utf8'));
var adHocAppEnvConfig = JSON.parse(fs.readFileSync(`src/examples/ad-hoc/config/${adHocAppEnvName}.json`, 'utf8'));

// https://docs.aws.amazon.com/cdk/v2/guide/stack_how_to_create_multiple_stacks.html
const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const baseStack = new Stack(app, 'ExampleAdHocBaseStack', { env, stackName: adHocBaseEnvName });
baseStack.node.setContext('config', adHocBaseEnvConfig);

const appStack = new Stack(app, 'ExampleAdHocAppStack', { env, stackName: adHocAppEnvName });
appStack.node.setContext('config', adHocAppEnvConfig);

const certificateArn = process.env.ACM_CERTIFICATE_ARN || 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012';
const domainName = process.env.DOMAIN_NAME || 'example.com';

const adHocBase = new AdHocBase(baseStack, 'AdHocBase', { certificateArn, domainName });

// const adHocApp = new AdHocApp(appStack, 'AdHocApp', {
//   baseStackName: adHocBaseEnvName,
//   vpc: adHocBase.vpc,
//   alb: adHocBase.alb,
//   appSecurityGroup: adHocBase.appSecurityGroup,
//   rdsInstance: adHocBase.databaseInstance,
//   assetsBucket: adHocBase.assetsBucket,
//   domainName: adHocBase.domainName,
//   listener: adHocBase.listener,
//   elastiCacheHost: adHocBase.elastiCacheHostname,
// });

/**
 * Add tagging for this construct and all child constructs
 */
Tags.of(adHocBase).add('base-env', adHocBaseEnvName);
Tags.of(adHocBase).add('ad-hoc', 'true');
// Tags.of(adHocApp).add('app-env', adHocAppEnvName);