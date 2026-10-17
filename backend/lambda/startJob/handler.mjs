"use strict";

import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

export const ecs = new ECSClient({});
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const STALE_MS = 4 * 60 * 60 * 1000;

export const handler = async (event) => {
  const keys = keysFromEvent(event);
  const started = [];
  const skipped = [];
  const failed = [];

  for (const rawKey of keys) {
    const key = decodeURIComponent(String(rawKey || "")).replace(/\+/g, " ");
    const parsed = parseReadyKey(key);
    if (!parsed) {
      skipped.push(key);
      continue;
    }
    const pk = `JOB#${parsed.jobId}`;
    try {
      const existing = await ddb.send(new GetCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { pk, sk: "META" },
      }));
      if (shouldSkipExisting(existing.Item?.status, existing.Item?.updatedAt, Date.now())) {
        skipped.push(parsed.jobId);
        continue;
      }

      const now = new Date().toISOString();
      const filename = existing.Item?.filename || "";
      const discName = stem(filename) || parsed.jobId;
      const outputPrefix = existing.Item?.outputPrefix || parsed.outputPrefix;
      const item = {
        ...(existing.Item || {}),
        pk,
        sk: "META",
        jobId: parsed.jobId,
        disc: discName,
        ingestKey: parsed.ingestPrefix,
        outputPrefix,
        status: "CONVERTING",
        createdAt: existing.Item?.createdAt || now,
        updatedAt: now,
      };
      if (parsed.userId) item.userId = parsed.userId;
      if (parsed.source) item.source = parsed.source;
      await ddb.send(new PutCommand({ TableName: process.env.JOBS_TABLE, Item: item }));

      const env = [
        { name: "DISC_NAME", value: discName },
        { name: "INCOMING_PREFIX", value: parsed.ingestPrefix },
        { name: "OUTPUT_PREFIX", value: outputPrefix },
        { name: "JOB_PK", value: pk },
        { name: "SOURCE", value: item.source || parsed.source },
      ];
      if (item.userId) env.push({ name: "USER_ID", value: item.userId });
      if (filename) env.push({ name: "FILENAME", value: filename });
      env.push(...editTaskEnvironment(item));

      const run = await ecs.send(new RunTaskCommand({
        cluster: process.env.CLUSTER_ARN,
        taskDefinition: process.env.TASK_DEF_ARN,
        launchType: "FARGATE",
        startedBy: `ready-${parsed.jobId}`.slice(0, 36),
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: (process.env.SUBNETS || "").split(",").map((s) => s.trim()).filter(Boolean),
            securityGroups: process.env.SECURITY_GROUP ? [process.env.SECURITY_GROUP] : [],
            assignPublicIp: "ENABLED",
          },
        },
        overrides: {
          containerOverrides: [{ name: process.env.CONTAINER_NAME || "ffmpeg", environment: env }],
        },
      }));
      if (!run.tasks?.length) {
        const reason = run.failures?.[0]?.reason || run.failures?.[0]?.detail || "RunTask returned no tasks";
        throw new Error(reason);
      }
      const taskArn = run.tasks[0].taskArn || "";
      if (taskArn) {
        await ddb.send(new PutCommand({
          TableName: process.env.JOBS_TABLE,
          Item: { ...item, taskArn, updatedAt: new Date().toISOString() },
        }));
      }
      started.push(parsed.jobId);
    } catch (err) {
      const message = err?.message || String(err);
      failed.push({ jobId: parsed.jobId, error: message });
      try {
        const existing = await ddb.send(new GetCommand({
          TableName: process.env.JOBS_TABLE,
          Key: { pk, sk: "META" },
        }));
        await ddb.send(new PutCommand({
          TableName: process.env.JOBS_TABLE,
          Item: {
            ...(existing.Item || {}),
            pk,
            sk: "META",
            jobId: parsed.jobId,
            ingestKey: parsed.ingestPrefix,
            status: "FAILED",
            error: message,
            updatedAt: new Date().toISOString(),
          },
        }));
      } catch (putErr) {
        console.error("failed to record job error", putErr);
      }
    }
  }

  return { started, skipped, failed };
};

export function shouldSkipExisting(status, updatedAt, now = Date.now()) {
  const updatedMs = Date.parse(updatedAt || "") || 0;
  const stale = status === "CONVERTING" && now - updatedMs > STALE_MS;
  return (status === "READY" || status === "CONVERTING") && !stale;
}

export function editTaskEnvironment(item) {
  const kind = String(item?.kind || "");
  if (kind !== "clip" && kind !== "combine") return [];
  const env = [
    { name: "EDIT_KIND", value: kind },
    { name: "SOURCE_KEYS", value: JSON.stringify(item.sourceKeys || []) },
  ];
  if (item.clipStart) env.push({ name: "CLIP_START", value: String(item.clipStart) });
  if (item.clipEnd) env.push({ name: "CLIP_END", value: String(item.clipEnd) });
  return env;
}

export function parseReadyKey(key) {
  const parts = String(key || "").replace(/^\/+/, "").split("/");
  if (parts[0] !== "incoming") return null;
  if (parts[parts.length - 1] !== "ready") return null;
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  if (parts.length === 3) {
    const jobId = parts[1].trim();
    if (!jobId) return null;
    return {
      source: "cli",
      jobId,
      ingestPrefix: `incoming/${jobId}/`,
      outputPrefix: "Videos/",
    };
  }
  if (parts.length === 4) {
    const userId = parts[1].trim();
    const jobId = parts[2].trim();
    if (!userId || !jobId) return null;
    return {
      source: "web",
      userId,
      jobId,
      ingestPrefix: `incoming/${userId}/${jobId}/`,
      outputPrefix: `users/${userId}/Videos/`,
    };
  }
  return null;
}

function stem(filename) {
  const name = String(filename || "").split(/[/\\]/).pop() || "";
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function keysFromEvent(event) {
  if (event?.detail?.object?.key) return [event.detail.object.key];
  const records = event?.Records || [];
  return records.map((r) => r.s3?.object?.key).filter(Boolean);
}
