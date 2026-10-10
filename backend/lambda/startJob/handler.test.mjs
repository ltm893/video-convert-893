import { test } from "node:test";
import assert from "node:assert/strict";
import { stubClients } from "../awsMock.mjs";
import { ddb, ecs, handler } from "./handler.mjs";

function awsEnv() {
  process.env.JOBS_TABLE = "test-jobs";
  process.env.CLUSTER_ARN = "cluster";
  process.env.TASK_DEF_ARN = "taskdef";
  process.env.SUBNETS = "subnet-a";
  delete process.env.SECURITY_GROUP;
  delete process.env.CONTAINER_NAME;
}

function readyEvent(key) {
  return { Records: [{ s3: { object: { key } } }] };
}

test("a new ready marker starts Fargate and stores the task", async () => {
  awsEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        GetCommand: async () => ({}),
        PutCommand: async () => ({}),
      },
    },
    ecs: {
      client: ecs,
      responders: {
        RunTaskCommand: async () => ({ tasks: [{ taskArn: "arn:aws:ecs:us-east-1:1:task/ffmpeg/abc" }] }),
      },
    },
  });
  try {
    const out = await handler({ detail: { object: { key: "incoming/Family/ready" } } });
    assert.deepEqual(out, { started: ["Family"], skipped: [], failed: [] });
    const puts = aws.named("PutCommand");
    assert.equal(puts[0].input.TableName, "test-jobs");
    assert.equal(puts[0].input.Item.status, "CONVERTING");
    assert.equal(puts[0].input.Item.outputPrefix, "Videos/");
    assert.equal(puts[1].input.Item.taskArn, "arn:aws:ecs:us-east-1:1:task/ffmpeg/abc");
    const run = aws.named("RunTaskCommand")[0].input;
    assert.equal(run.cluster, "cluster");
    assert.equal(run.taskDefinition, "taskdef");
    assert.deepEqual(run.networkConfiguration.awsvpcConfiguration.subnets, ["subnet-a"]);
    assert.equal(run.overrides.containerOverrides[0].name, "ffmpeg");
  } finally {
    aws.restore();
  }
});

test("an S3 key with + is a space before the job id is parsed", async () => {
  awsEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        GetCommand: async () => ({}),
        PutCommand: async () => ({}),
      },
    },
    ecs: {
      client: ecs,
      responders: {
        RunTaskCommand: async () => ({ tasks: [{ taskArn: "arn:task/1" }] }),
      },
    },
  });
  try {
    const out = await handler(readyEvent("incoming/DVD+Video/ready"));
    assert.deepEqual(out.started, ["DVD Video"]);
    assert.equal(aws.named("PutCommand")[0].input.Item.jobId, "DVD Video");
  } finally {
    aws.restore();
  }
});

test("a READY job is skipped and Fargate is not called", async () => {
  awsEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        GetCommand: async () => ({ Item: { status: "READY", updatedAt: "2026-10-10T12:00:00Z" } }),
      },
    },
    ecs: {
      client: ecs,
      responders: {},
    },
  });
  try {
    const out = await handler(readyEvent("incoming/Family/ready"));
    assert.deepEqual(out, { started: [], skipped: ["Family"], failed: [] });
    assert.equal(aws.named("RunTaskCommand").length, 0);
    assert.equal(aws.named("PutCommand").length, 0);
  } finally {
    aws.restore();
  }
});

test("RunTask with no tasks marks the job FAILED", async () => {
  awsEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        GetCommand: async () => ({}),
        PutCommand: async () => ({}),
      },
    },
    ecs: {
      client: ecs,
      responders: {
        RunTaskCommand: async () => ({ tasks: [], failures: [{ reason: "capacity" }] }),
      },
    },
  });
  try {
    const out = await handler(readyEvent("incoming/Family/ready"));
    assert.deepEqual(out.started, []);
    assert.deepEqual(out.failed, [{ jobId: "Family", error: "capacity" }]);
    const failed = aws.named("PutCommand").at(-1).input.Item;
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error, "capacity");
  } finally {
    aws.restore();
  }
});
