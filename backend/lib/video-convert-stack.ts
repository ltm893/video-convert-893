// backend/lib/video-convert-stack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";

export interface VideoConvertConfig {
  id: string;
  awsRegion: string;
  userPoolId: string;
  privateBucket: string;
}

export interface VideoConvertStackProps extends cdk.StackProps {
  config: VideoConvertConfig;
  videoConvertApiLogicalId?: string;
}

const CORS_EXPOSE = ["ETag", "Content-Length", "Content-Type", "Accept-Ranges", "Content-Range"];

export class VideoConvertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VideoConvertStackProps) {
    super(scope, id, props);

    const { config, videoConvertApiLogicalId } = props;
    const ingestBucketName = `${config.id}-video-ingest`;
    const sharedOutputPrefix = "Videos/";

    const userPool = cognito.UserPool.fromUserPoolId(this, "UserPool", config.userPoolId);
    const privateBucket = s3.Bucket.fromBucketName(this, "PrivateBucket", config.privateBucket);

    const ingestBucket = new s3.Bucket(this, "IngestBucket", {
      bucketName: ingestBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      eventBridgeEnabled: true,
      cors: [{
        allowedOrigins: ["*"],
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT, s3.HttpMethods.POST],
        allowedHeaders: ["*"],
        exposedHeaders: CORS_EXPOSE,
        maxAge: 3600,
      }],
      lifecycleRules: [{
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
      }],
    });

    const table = new dynamodb.Table(this, "JobsTable", {
      tableName: `${config.id}-video-convert-jobs`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: "userId-createdAt-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${config.id}-video-convert`,
    });

    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", {
      vpc,
      allowAllOutbound: true,
      description: `${config.id} ffmpeg convert worker`,
    });

    const logGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: `/ecs/${config.id}-video-convert`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "ConvertTask", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      ephemeralStorageGiB: 50,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDef.addContainer("ffmpeg", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../worker"), {
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "convert",
      }),
      environment: {
        INGEST_BUCKET: ingestBucket.bucketName,
        OUTPUT_BUCKET: config.privateBucket,
        OUTPUT_PREFIX: sharedOutputPrefix,
        JOBS_TABLE: table.tableName,
        AWS_DEFAULT_REGION: config.awsRegion,
      },
    });

    ingestBucket.grantReadWrite(taskDef.taskRole);
    ingestBucket.grantDelete(taskDef.taskRole);
    table.grantReadWriteData(taskDef.taskRole);
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject"],
      resources: [`${privateBucket.bucketArn}/users/*/Videos/*`],
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      resources: [
        `${privateBucket.bucketArn}/${sharedOutputPrefix}*`,
        `${privateBucket.bucketArn}/users/*/Videos/*`,
        `${privateBucket.bucketArn}/users/*/Music/*`,
      ],
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [privateBucket.bucketArn],
      conditions: {
        StringLike: {
          "s3:prefix": [sharedOutputPrefix, `${sharedOutputPrefix}*`, "users/", "users/*"],
        },
      },
    }));

    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC });
    const startJobFn = new lambda.Function(this, "StartJob", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/startJob")),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        JOBS_TABLE: table.tableName,
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEF_ARN: taskDef.taskDefinitionArn,
        CONTAINER_NAME: "ffmpeg",
        SUBNETS: publicSubnets.subnetIds.join(","),
        SECURITY_GROUP: workerSg.securityGroupId,
        INGEST_BUCKET: ingestBucket.bucketName,
      },
    });
    table.grantReadWriteData(startJobFn);
    startJobFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ecs:RunTask"],
      resources: [taskDef.taskDefinitionArn, cluster.clusterArn],
    }));
    startJobFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"],
      resources: [
        taskDef.taskRole.roleArn,
        taskDef.obtainExecutionRole().roleArn,
      ],
    }));

    new events.Rule(this, "DiscReady", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [ingestBucket.bucketName] },
          object: { key: [{ suffix: "/ready" }] },
        },
      },
      targets: [new targets.LambdaFunction(startJobFn)],
    });

    const uploadFn = new lambda.Function(this, "UploadApi", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/uploadApi")),
      timeout: cdk.Duration.seconds(29),
      memorySize: 256,
      environment: {
        INGEST_BUCKET: ingestBucket.bucketName,
        JOBS_TABLE: table.tableName,
        CLUSTER_ARN: cluster.clusterArn,
      },
    });
    table.grantReadWriteData(uploadFn);
    ingestBucket.grantReadWrite(uploadFn);
    uploadFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts", "s3:AbortMultipartUpload"],
      resources: [ingestBucket.bucketArn, `${ingestBucket.bucketArn}/*`],
    }));
    uploadFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ecs:ListTasks"],
      resources: ["*"],
    }));
    uploadFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["ecs:StopTask"],
      resources: [
        this.formatArn({
          service: "ecs",
          resource: "task",
          resourceName: `${cluster.clusterName}/*`,
          arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
        }),
      ],
    }));

    const api = new apigateway.RestApi(this, "VideoConvertApi", {
      restApiName: `${config.id}-video-convert-api`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });
    api.addGatewayResponse("Default4XX", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
      },
    });
    api.addGatewayResponse("Default5XX", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'",
        "Access-Control-Allow-Headers": "'Authorization,Content-Type'",
      },
    });
    if (videoConvertApiLogicalId) {
      const cfnApi = api.node.defaultChild as cdk.CfnResource;
      cfnApi.overrideLogicalId(videoConvertApiLogicalId);
    }

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "VideoConvertAuthorizer", {
      cognitoUserPools: [userPool],
    });
    const authOptions: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    const uploadIntegration = new apigateway.LambdaIntegration(uploadFn);
    const jobs = api.root.addResource("jobs");
    jobs.addMethod("GET", uploadIntegration, authOptions);
    jobs.addMethod("PATCH", uploadIntegration, authOptions);
    jobs.addMethod("DELETE", uploadIntegration, authOptions);
    const uploads = api.root.addResource("uploads");
    uploads.addMethod("POST", uploadIntegration, authOptions);
    uploads.addResource("parts").addMethod("POST", uploadIntegration, authOptions);
    uploads.addResource("complete").addMethod("POST", uploadIntegration, authOptions);
    uploads.addResource("abort").addMethod("POST", uploadIntegration, authOptions);
    uploads.addResource("ready").addMethod("POST", uploadIntegration, authOptions);
    api.root.addResource("edits").addMethod("POST", uploadIntegration, authOptions);

    new cdk.CfnOutput(this, "VideoConvertApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "VideoConvertIngestBucket", { value: ingestBucket.bucketName });
    new cdk.CfnOutput(this, "VideoConvertOutputBucket", { value: config.privateBucket });
    new cdk.CfnOutput(this, "VideoConvertOutputPrefix", { value: sharedOutputPrefix });
    new cdk.CfnOutput(this, "VideoConvertJobsTable", { value: table.tableName });
    new cdk.CfnOutput(this, "VideoConvertCluster", { value: cluster.clusterArn });
    new cdk.CfnOutput(this, "VideoConvertUserPoolId", { value: config.userPoolId });
  }
}
