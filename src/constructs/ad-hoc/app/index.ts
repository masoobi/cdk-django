import { CfnOutput, Stack } from 'aws-cdk-lib';
import { IVpc, ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Cluster, EcrImage } from 'aws-cdk-lib/aws-ecs';
import { IApplicationLoadBalancer, ApplicationListener } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { DatabaseInstance } from 'aws-cdk-lib/aws-rds';
import { CnameRecord, HostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
// import { HighestPriorityRule } from '../../internal/customResources/highestPriorityRule';
import { EcsRoles } from '../../internal/ecs/iam';
import { ManagementCommandTask } from '../../internal/ecs/management-command';
import { WebService } from '../../internal/ecs/web';
import { WorkerService } from '../../internal/ecs/worker';

export interface AdHocAppProps {
  readonly baseStackName: string;
  readonly vpc: IVpc;
  readonly alb: IApplicationLoadBalancer;
  readonly appSecurityGroup: ISecurityGroup;
  readonly rdsInstance: DatabaseInstance;
  readonly assetsBucket: Bucket;
  readonly domainName: string;
  readonly listener: ApplicationListener;
  readonly elastiCacheHost: string;
}

export class AdHocApp extends Construct {

  constructor(scope: Construct, id: string, props: AdHocAppProps) {
    super(scope, id);

    const stackName = Stack.of(this).stackName;

    // custom resource to get the highest available listener rule priority
    // then take the next two highest priorities and use them for the frontend and backend listener rule priorities
    // https://github.com/aws-samples/aws-cdk-examples/blob/master/typescript/custom-resource/index.ts

    // const highestPriorityRule = new HighestPriorityRule(this, 'HighestPriorityRule', { listener: props.listener });

    const backendEcrRepo = Repository.fromRepositoryName(this, 'BackendRepo', 'backend');
    const backendVersion = 'latest';
    const backendImage = new EcrImage(backendEcrRepo, backendVersion);

    const frontendEcrRepo = Repository.fromRepositoryName(this, 'FrontendRepo', 'frontend');
    const frontendVersion = 'latest';
    const frontendImage = new EcrImage(frontendEcrRepo, frontendVersion);

    const cluster = new Cluster(this, 'Cluster', {
      clusterName: `${stackName}-cluster`,
      vpc: props.vpc,
      enableFargateCapacityProviders: true,
    });

    const settingsModule = this.node.tryGetContext('config').settingsModule ?? 'backend.settings.production';
    // shared environment variables
    let environmentVariables: { [key: string]: string } = {
      S3_BUCKET_NAME: props.assetsBucket.bucketName,
      REDIS_SERVICE_HOST: props.elastiCacheHost,
      POSTGRES_SERVICE_HOST: props.rdsInstance.dbInstanceEndpointAddress,
      POSTGRES_NAME: stackName,
      DJANGO_SETTINGS_MODULE: settingsModule,
      FRONTEND_URL: `https://${stackName}.${props.domainName}`,
      DOMAIN_NAME: props.domainName,
      // TODO: read this from ad hoc base stack
      DB_SECRET_NAME: 'DB_SECRET_NAME',
      APP_ENV_NAME: stackName, // e.g. alpha
      BASE_ENV_NAME: props.baseStackName, // e.g. dev
      AD_HOC_ENV: 'True', // used in application code
      FOO: 'foo',
    };

    const extraEnvVars = this.node.tryGetContext('config').extraEnvVars;

    if (extraEnvVars) {
      environmentVariables = { ...extraEnvVars, ...environmentVariables };
    }

    // define ecsTaskRole and taskExecutionRole for ECS
    const ecsRoles = new EcsRoles(scope, 'EcsRoles');

    // allow the task role to read and write to the bucket
    props.assetsBucket.grantReadWrite(ecsRoles.ecsTaskRole);

    // Route53
    // skip route 53 until domain is moved to Route53
    // const hostedZone = HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName });
    // const cnameRecord = new CnameRecord(this, 'CnameApiRecord', {
    //   recordName: stackName,
    //   domainName: props.alb.loadBalancerDnsName,
    //   zone: hostedZone,
    // });

    // api service
    // const backendService =
    new WebService(this, 'ApiService', {
      cluster,
      environmentVariables,
      vpc: props.vpc,
      appSecurityGroup: props.appSecurityGroup,
      taskRole: ecsRoles.ecsTaskRole,
      executionRole: ecsRoles.taskExecutionRole,
      image: backendImage,
      listener: props.listener,
      command: [
        'gunicorn',
        '-t',
        '1000',
        '-b',
        '0.0.0.0:8000',
        '--log-level',
        'info',
        'backend.wsgi',
      ],
      name: 'gunicorn',
      port: 8000,
      domainName: props.domainName,
      pathPatterns: ['/api/*', '/admin/*', '/mtv/*', '/graphql/*'],
      priority: 2, //highestPriorityRule.priority + 1,
      healthCheckPath: '/api/health-check/',
    });

    // frontend service
    // const frontendService =
    new WebService(this, 'FrontendService', {
      cluster,
      environmentVariables: {},
      vpc: props.vpc,
      appSecurityGroup: props.appSecurityGroup,
      taskRole: ecsRoles.ecsTaskRole,
      executionRole: ecsRoles.taskExecutionRole,
      image: frontendImage,
      listener: props.listener,
      command: ['nginx', '-g', 'daemon off;'],
      name: 'web-ui',
      port: 80,
      domainName: props.domainName,
      pathPatterns: ['/*'],
      priority: 3, // highestPriorityRule.priority + 2,
      healthCheckPath: '/',
    });

    // worker service
    new WorkerService(this, 'DefaultCeleryWorker', {
      cluster,
      environmentVariables,
      vpc: props.vpc,
      appSecurityGroup: props.appSecurityGroup,
      taskRole: ecsRoles.ecsTaskRole,
      executionRole: ecsRoles.taskExecutionRole,
      image: backendImage,
      command: [
        'celery',
        '--app=backend.celery_app:app',
        'worker',
        '--loglevel=INFO',
        '-Q',
        'default',
      ],
      name: 'default-worker',
    });

    // scheduler service

    // management command task definition
    const backendUpdateTask = new ManagementCommandTask(this, 'update', {
      cluster,
      environmentVariables,
      vpc: props.vpc,
      appSecurityGroup: props.appSecurityGroup,
      taskRole: ecsRoles.ecsTaskRole,
      executionRole: ecsRoles.taskExecutionRole,
      image: backendImage,
      command: ['python', 'manage.py', 'pre_update'],
      name: 'update',
    });

    // worker service
    new WorkerService(this, 'EcsExecBastion', {
      cluster,
      environmentVariables,
      vpc: props.vpc,
      appSecurityGroup: props.appSecurityGroup,
      taskRole: ecsRoles.ecsTaskRole,
      executionRole: ecsRoles.taskExecutionRole,
      image: backendImage,
      command: ['sh', '-c', 'tail -f /dev/null'],
      name: 'ecs-exec',
    });

    // define stack output use for running the management command
    new CfnOutput(this, 'backendUpdateCommand', { value: backendUpdateTask.executionScript });
    // new CfnOutput(this, 'domainName', { value: cnameRecord.domainName });
  }
}
