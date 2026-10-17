import { test } from "node:test";
import assert from "node:assert/strict";
import { stubClients } from "../awsMock.mjs";
import { ddb, handler, s3 } from "./handler.mjs";

const userId = "11111111-2222-3333-4444-555555555555";

function event(overrides = {}) {
  return {
    httpMethod: "GET",
    path: "/jobs",
    requestContext: { authorizer: { claims: { sub: userId } } },
    ...overrides,
  };
}

test("missing or short Cognito sub is 401", async () => {
  const missing = await handler({ httpMethod: "GET", path: "/jobs" });
  assert.equal(missing.statusCode, 401);
  assert.equal(JSON.parse(missing.body).error, "Unauthorized");

  const short = await handler(event({
    requestContext: { authorizer: { claims: { sub: "abc" } } },
  }));
  assert.equal(short.statusCode, 401);
  assert.equal(JSON.parse(short.body).error, "Unauthorized");
});

test("body that is not JSON is 400", async () => {
  const response = await handler(event({
    httpMethod: "POST",
    path: "/uploads",
    body: "{",
  }));
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "invalid JSON");
});

test("unknown path is 404", async () => {
  const response = await handler(event({ path: "/nope" }));
  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error, "Not found");
});

function apiEnv() {
  process.env.JOBS_TABLE = "test-jobs";
  process.env.INGEST_BUCKET = "test-ingest";
  delete process.env.CLUSTER_ARN;
}

function emptyBucket() {
  return {
    ListObjectsV2Command: async () => ({ Contents: [] }),
    ListMultipartUploadsCommand: async () => ({ Uploads: [] }),
    PutObjectCommand: async () => ({}),
    CreateMultipartUploadCommand: async () => ({ UploadId: "up-1" }),
  };
}

test("GET /jobs returns rows from the mocked query", async () => {
  apiEnv();
  const key = `users/${userId}/Videos/Race.mp4`;
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        QueryCommand: async () => ({
          Items: [{
            jobId: "job-1",
            pk: "JOB#job-1",
            filename: "Race.mp4",
            kind: "file",
            status: "READY",
            outputKeys: [key],
            outputPrefix: `users/${userId}/Videos/`,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T01:00:00Z",
          }],
        }),
      },
    },
    s3: { client: s3, responders: emptyBucket() },
  });
  try {
    const response = await handler(event({ httpMethod: "GET", path: "/jobs" }));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].jobId, "job-1");
    assert.deepEqual(body.jobs[0].outputKeys, [key]);
    assert.equal(aws.named("QueryCommand")[0].input.TableName, "test-jobs");
    assert.equal(aws.named("QueryCommand")[0].input.ExpressionAttributeValues[":u"], userId);
  } finally {
    aws.restore();
  }
});

test("POST /edits writes the job, edit.json, and the ready marker", async () => {
  apiEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: { PutCommand: async () => ({}) },
    },
    s3: { client: s3, responders: emptyBucket() },
  });
  try {
    const response = await handler(event({
      httpMethod: "POST",
      path: "/edits",
      body: JSON.stringify({
        kind: "clip",
        sourceKey: `users/${userId}/Videos/Race.mp4`,
        start: "1:30.5",
        end: "2:00",
        name: "Highlight",
      }),
    }));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.kind, "clip");
    assert.equal(body.filename, "Highlight.mp4");
    assert.equal(body.status, "QUEUED");
    const item = aws.named("PutCommand")[0].input.Item;
    assert.equal(item.jobId, body.jobId);
    assert.equal(item.status, "QUEUED");
    assert.equal(item.clipStart, "0:01:30.5");
    assert.equal(item.clipEnd, "0:02:00");
    const objects = aws.named("PutObjectCommand").map((call) => call.input);
    assert.deepEqual(objects.map((obj) => obj.Key), [
      `incoming/${userId}/${body.jobId}/edit.json`,
      `incoming/${userId}/${body.jobId}/ready`,
    ]);
    assert.equal(objects[0].Bucket, "test-ingest");
  } finally {
    aws.restore();
  }
});

test("POST /uploads starts a multipart upload and an UPLOADING job", async () => {
  apiEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: { PutCommand: async () => ({}) },
    },
    s3: { client: s3, responders: emptyBucket() },
  });
  try {
    const response = await handler(event({
      httpMethod: "POST",
      path: "/uploads",
      body: JSON.stringify({ filename: "holiday.mp4", contentType: "video/mp4" }),
    }));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.uploadId, "up-1");
    assert.equal(body.filename, "holiday.mp4");
    assert.equal(body.key, `incoming/${userId}/${body.jobId}/holiday.mp4`);
    const created = aws.named("CreateMultipartUploadCommand")[0].input;
    assert.equal(created.Bucket, "test-ingest");
    assert.equal(created.Key, body.key);
    assert.equal(aws.named("PutCommand")[0].input.Item.status, "UPLOADING");
  } finally {
    aws.restore();
  }
});

test("GET /jobs deletes the older READY row with the same name", async () => {
  apiEnv();
  const aws = stubClients({
    ddb: {
      client: ddb,
      responders: {
        QueryCommand: async () => ({
          Items: [
            {
              jobId: "new",
              pk: "JOB#new",
              filename: "CampingDragRacing",
              status: "READY",
              createdAt: "2026-09-30T10:00:00Z",
            },
            {
              jobId: "old",
              pk: "JOB#old",
              filename: "CampingDragRacing",
              status: "READY",
              createdAt: "2026-09-28T10:00:00Z",
              ingestKey: `incoming/${userId}/old/`,
            },
          ],
        }),
        DeleteCommand: async () => ({}),
      },
    },
    s3: { client: s3, responders: emptyBucket() },
  });
  try {
    const response = await handler(event({ httpMethod: "GET", path: "/jobs" }));
    assert.equal(response.statusCode, 200);
    const ids = JSON.parse(response.body).jobs.map((job) => job.jobId);
    assert.deepEqual(ids, ["new"]);
    assert.deepEqual(aws.named("DeleteCommand")[0].input.Key, { pk: "JOB#old", sk: "META" });
    assert.equal(aws.named("ListObjectsV2Command")[0].input.Prefix, `incoming/${userId}/old/`);
  } finally {
    aws.restore();
  }
});
