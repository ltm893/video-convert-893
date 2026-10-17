#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { VideoConvertStack } from "../lib/video-convert-stack";
import { withBaseId } from "./baseConfig";
import { config as localConfig } from "./config";

const config = withBaseId(localConfig);

const app = new cdk.App();
const stackName = `VideoConvertStack-${config.id}`;

new VideoConvertStack(app, stackName, {
  config,
  videoConvertApiLogicalId: process.env.VIDEO_CONVERT_API_LOGICAL_ID || undefined,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: config.awsRegion,
  },
});
