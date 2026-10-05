"use strict";

import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { ECSClient, ListTasksCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  extensionOf,
  ingestPrefixForJob,
  isJobId,
  jobsToSupersede,
  jobTouchesPrefix,
  nextCdAlbumPrefix,
  ownedUserFileKey,
  ownedUserPrefix,
  parseOwnedKey,
  removeDeletedOutput,
  remapJobOutput,
  safeRelPath,
  slugName,
  buildEditPlan,
} from "./paths.mjs";

const s3 = new S3Client({});
const ecs = new ECSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INGEST_BUCKET = process.env.INGEST_BUCKET;
const JOBS_TABLE = process.env.JOBS_TABLE;
const CLUSTER_ARN = process.env.CLUSTER_ARN;
const PUT_EXPIRES = 900;
const USER_INDEX = "userId-createdAt-index";

export const handler = async (event) => {
  try {
    const method = event.httpMethod;
    const resource = event.resource || event.path || "";
    const body = parseBody(event.body);
    const userId = userSub(event);

    if (method === "GET" && resource.endsWith("/jobs")) {
      return await listJobs(userId);
    }
    if (method === "PATCH" && resource.endsWith("/jobs")) {
      return await remapJobOutputs(userId, body);
    }
    if (method === "DELETE" && resource.endsWith("/jobs")) {
      return await deleteJobs(userId, { ...body, ...event.queryStringParameters });
    }
    if (method === "POST" && resource.endsWith("/edits")) {
      return await createEdit(userId, body);
    }
    if (method === "POST" && resource === "/uploads") {
      return await initiateUpload(userId, body);
    }
    if (method === "POST" && resource.endsWith("/uploads/parts")) {
      return await signParts(userId, body);
    }
    if (method === "POST" && resource.endsWith("/uploads/complete")) {
      return await completeUpload(userId, body);
    }
    if (method === "POST" && resource.endsWith("/uploads/abort")) {
      return await abortUpload(userId, body);
    }
    if (method === "POST" && resource.endsWith("/uploads/ready")) {
      return await finishDiscUpload(userId, body);
    }
    return respond(404, { error: "Not found" });
  } catch (err) {
    const status = Number(err.statusCode) || 500;
    if (status >= 500) console.error(err);
    return respond(status, { error: err.message || "Error" });
  }
};

function userSub(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const sub = String(claims.sub || "").trim();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(sub)) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
  return sub;
}

function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON");
    err.statusCode = 400;
    throw err;
  }
}

function safeVideoName(raw) {
  const name = slugName(raw, "video").slice(0, 180);
  const ext = extensionOf(name);
  if (!VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext)) {
    const err = new Error("Upload a video or audio file.");
    err.statusCode = 400;
    throw err;
  }
  return name;
}

function stem(filename) {
  const name = String(filename || "video");
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) || "video";
}

async function loadOwnedJob(userId, jobId) {
  if (!isJobId(jobId)) {
    const err = new Error("jobId is required");
    err.statusCode = 400;
    throw err;
  }
  const existing = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: { pk: `JOB#${jobId}`, sk: "META" },
  }));
  if (!existing.Item || existing.Item.userId !== userId) {
    const err = new Error("invalid job");
    err.statusCode = 403;
    throw err;
  }
  return existing.Item;
}

async function initiateUpload(userId, body) {
  if ((body.kind === "disc" || body.kind === "audio") && !body.relativePath && !body.key) {
    return createDiscJob(userId, body);
  }
  if (body.jobId && (body.relativePath || body.filename)) {
    return initiateDiscFile(userId, body);
  }
  return initiateVideoFile(userId, body);
}

async function createEdit(userId, body) {
  const plan = buildEditPlan(userId, body);
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const ingestKey = `incoming/${userId}/${jobId}/`;
  const item = {
    pk: `JOB#${jobId}`,
    sk: "META",
    jobId,
    disc: stem(plan.filename),
    userId,
    source: "web",
    kind: plan.kind,
    filename: plan.filename,
    ingestKey,
    outputPrefix: plan.outputPrefix,
    sourceKeys: plan.sourceKeys,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
  };
  if (plan.clipStart) item.clipStart = plan.clipStart;
  if (plan.clipEnd) item.clipEnd = plan.clipEnd;
  await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: item }));
  await s3.send(new PutObjectCommand({
    Bucket: INGEST_BUCKET,
    Key: `${ingestKey}edit.json`,
    Body: JSON.stringify(plan),
    ContentType: "application/json",
  }));
  await s3.send(new PutObjectCommand({
    Bucket: INGEST_BUCKET,
    Key: `${ingestKey}ready`,
    Body: JSON.stringify({ jobId, userId, kind: plan.kind }),
    ContentType: "application/json",
  }));
  return respond(200, {
    jobId,
    filename: plan.filename,
    kind: plan.kind,
    outputPrefix: plan.outputPrefix,
    status: "QUEUED",
  });
}

async function createDiscJob(userId, body) {
  const filename = slugName(body.name || body.filename || "disc", "disc").replace(/\.(mp4|mov|m4v|aiff|aif|wav|flac|m4a|mp3)$/i, "") || "disc";
  const isAudio = String(body.kind || "") === "audio";
  const jobId = randomUUID();
  const now = new Date().toISOString();
  let outputPrefix = `users/${userId}/Videos/`;
  if (isAudio) {
    const musicRoot = `users/${userId}/Music/`;
    const items = await listUserJobItems(userId);
    const existing = items.flatMap((item) => [
      item.outputPrefix,
      ...(Array.isArray(item.outputKeys) ? item.outputKeys : []),
    ]);
    outputPrefix = nextCdAlbumPrefix(musicRoot, existing);
  }
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      pk: `JOB#${jobId}`,
      sk: "META",
      jobId,
      disc: filename,
      userId,
      source: "web",
      kind: isAudio ? "audio" : "disc",
      filename,
      ingestKey: `incoming/${userId}/${jobId}/`,
      outputPrefix,
      status: "UPLOADING",
      createdAt: now,
      updatedAt: now,
    },
  }));
  return respond(200, { jobId, filename, kind: isAudio ? "audio" : "disc", prefix: `incoming/${userId}/${jobId}/` });
}

async function initiateDiscFile(userId, body) {
  const job = await loadOwnedJob(userId, body.jobId);
  if (job.kind !== "disc" && job.kind !== "audio") {
    const err = new Error("invalid job");
    err.statusCode = 400;
    throw err;
  }
  if (job.status !== "UPLOADING") {
    const err = new Error("Upload already finished");
    err.statusCode = 400;
    throw err;
  }
  const relativePath = safeRelPath(body.relativePath || body.filename || body.key);
  const contentType = String(body.contentType || "application/octet-stream");
  const key = `incoming/${userId}/${job.jobId}/${relativePath}`;
  const started = await s3.send(new CreateMultipartUploadCommand({
    Bucket: INGEST_BUCKET,
    Key: key,
    ContentType: contentType,
  }));
  return respond(200, {
    key,
    uploadId: started.UploadId,
    jobId: job.jobId,
    filename: job.filename,
    relativePath,
    contentType,
  });
}

async function initiateVideoFile(userId, body) {
  const filename = safeVideoName(body.filename || body.key);
  const contentType = String(body.contentType || "application/octet-stream");
  const jobId = randomUUID();
  const key = `incoming/${userId}/${jobId}/${filename}`;
  const started = await s3.send(new CreateMultipartUploadCommand({
    Bucket: INGEST_BUCKET,
    Key: key,
    ContentType: contentType,
  }));
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      pk: `JOB#${jobId}`,
      sk: "META",
      jobId,
      disc: stem(filename),
      userId,
      source: "web",
      kind: "file",
      filename,
      ingestKey: `incoming/${userId}/${jobId}/`,
      outputPrefix: `users/${userId}/Videos/`,
      status: "UPLOADING",
      createdAt: now,
      updatedAt: now,
    },
  }));
  return respond(200, {
    key,
    uploadId: started.UploadId,
    jobId,
    filename,
    contentType,
  });
}

async function signParts(userId, body) {
  const { key } = parseOwnedKey(userId, body.key);
  const uploadId = String(body.uploadId || "");
  if (!uploadId) {
    const err = new Error("uploadId is required");
    err.statusCode = 400;
    throw err;
  }
  const numbers = Array.isArray(body.partNumbers) ? body.partNumbers : [body.partNumber];
  const partNumbers = [...new Set(numbers.map((n) => Math.floor(Number(n))))]
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 10000);
  if (!partNumbers.length) {
    const err = new Error("partNumber is required");
    err.statusCode = 400;
    throw err;
  }
  const urls = [];
  for (const partNumber of partNumbers) {
    const url = await getSignedUrl(
      s3,
      new UploadPartCommand({
        Bucket: INGEST_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PUT_EXPIRES }
    );
    urls.push({ partNumber, url });
  }
  return respond(200, { key, uploadId, urls });
}

async function completeUpload(userId, body) {
  const parsed = parseOwnedKey(userId, body.key);
  const uploadId = String(body.uploadId || "");
  const incoming = Array.isArray(body.parts) ? body.parts : [];
  if (!uploadId || !incoming.length) {
    const err = new Error("uploadId and parts are required");
    err.statusCode = 400;
    throw err;
  }
  const parts = incoming
    .map((p) => ({
      PartNumber: Math.floor(Number(p.partNumber ?? p.PartNumber)),
      ETag: quotedEtag(p.etag ?? p.ETag),
    }))
    .filter((p) => p.PartNumber >= 1 && p.ETag)
    .sort((a, b) => a.PartNumber - b.PartNumber);
  if (!parts.length) {
    const err = new Error("parts must include partNumber and etag");
    err.statusCode = 400;
    throw err;
  }
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: INGEST_BUCKET,
    Key: parsed.key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
  const existing = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: { pk: `JOB#${parsed.jobId}`, sk: "META" },
  }));
  const job = existing.Item || {};
  if (job.userId && job.userId !== userId) {
    const err = new Error("invalid key");
    err.statusCode = 403;
    throw err;
  }
  const now = new Date().toISOString();
  const isFolderJob = job.kind === "disc" || job.kind === "audio";
  const outputPrefix = job.outputPrefix || `users/${userId}/${job.kind === "audio" ? "Music" : "Videos"}/`;
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      ...job,
      pk: `JOB#${parsed.jobId}`,
      sk: "META",
      jobId: parsed.jobId,
      userId,
      source: "web",
      kind: job.kind || "file",
      filename: isFolderJob ? (job.filename || parsed.filename) : parsed.filename,
      disc: isFolderJob ? (job.disc || job.filename) : (job.disc || stem(parsed.filename)),
      ingestKey: parsed.prefix,
      outputPrefix,
      status: job.status === "CONVERTING" ? "CONVERTING" : "UPLOADING",
      updatedAt: now,
      createdAt: job.createdAt || now,
    },
  }));
  if (!isFolderJob) {
    await s3.send(new PutObjectCommand({
      Bucket: INGEST_BUCKET,
      Key: `${parsed.prefix}ready`,
      Body: JSON.stringify({ jobId: parsed.jobId, userId, filename: parsed.filename }),
      ContentType: "application/json",
    }));
  }
  return respond(200, { key: parsed.key, uploadId, jobId: parsed.jobId, completed: true });
}

async function finishDiscUpload(userId, body) {
  const job = await loadOwnedJob(userId, body.jobId);
  if (job.kind !== "disc" && job.kind !== "audio") {
    const err = new Error("invalid job");
    err.statusCode = 400;
    throw err;
  }
  if (job.status === "READY" || job.status === "CONVERTING") {
    return respond(200, { jobId: job.jobId, started: true });
  }
  if (job.status !== "UPLOADING") {
    const err = new Error("Upload cannot be finished");
    err.statusCode = 400;
    throw err;
  }
  const prefix = job.ingestKey || `incoming/${userId}/${job.jobId}/`;
  await s3.send(new PutObjectCommand({
    Bucket: INGEST_BUCKET,
    Key: `${prefix.endsWith("/") ? prefix : `${prefix}/`}ready`,
    Body: JSON.stringify({ jobId: job.jobId, userId, filename: job.filename, kind: "disc" }),
    ContentType: "application/json",
  }));
  return respond(200, { jobId: job.jobId, started: true });
}

async function abortUpload(userId, body) {
  const parsed = parseOwnedKey(userId, body.key);
  const uploadId = String(body.uploadId || "");
  if (!uploadId) {
    const err = new Error("uploadId is required");
    err.statusCode = 400;
    throw err;
  }
  await s3.send(new AbortMultipartUploadCommand({
    Bucket: INGEST_BUCKET,
    Key: parsed.key,
    UploadId: uploadId,
  }));
  const existing = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: { pk: `JOB#${parsed.jobId}`, sk: "META" },
  }));
  if (existing.Item && existing.Item.userId === userId && existing.Item.kind !== "disc" && existing.Item.kind !== "audio") {
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        ...existing.Item,
        status: "FAILED",
        error: "Upload aborted",
        updatedAt: now,
      },
    }));
  }
  return respond(200, { key: parsed.key, uploadId, aborted: true });
}

async function listJobs(userId) {
  let items = await listUserJobItems(userId);
  const removed = new Set();
  for (const item of jobsToSupersede(items)) {
    const id = jobIdOf(item);
    if (!id || removed.has(id)) continue;
    await wipeJob(userId, item);
    removed.add(id);
  }
  if (removed.size) items = items.filter((item) => !removed.has(jobIdOf(item)));
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const jobs = [];
  for (const item of items.slice(0, 50)) {
    const job = {
      jobId: item.jobId || String(item.pk || "").replace(/^JOB#/, ""),
      filename: item.filename || "",
      kind: item.kind || "",
      status: item.status || "",
      error: item.error || "",
      outputKeys: item.outputKeys || [],
      outputPrefix: item.outputPrefix || "",
      createdAt: item.createdAt || "",
      updatedAt: item.updatedAt || "",
    };
    if (item.status === "UPLOADING") {
      job.uploadProgress = await jobUploadProgress(userId, item);
    }
    jobs.push(job);
  }
  return respond(200, { jobs });
}

async function listUserJobItems(userId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: USER_INDEX,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
      ExclusiveStartKey,
    }));
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function ownedRenameKey(userId, raw) {
  const text = String(raw || "").replace(/^\/+/, "");
  if (text.endsWith("/")) return ownedUserPrefix(userId, text);
  return ownedUserFileKey(userId, text);
}

async function remapJobOutputs(userId, body) {
  const fromRaw = body.fromPrefix || body.fromKey || body.key;
  const destRaw = body.destPrefix || body.destKey || body.toKey;
  const fromKey = ownedRenameKey(userId, fromRaw);
  const destKey = ownedRenameKey(userId, destRaw);
  if (fromKey === destKey) return respond(200, { updated: 0, jobs: [] });
  const updated = [];
  for (const item of await listUserJobItems(userId)) {
    const { changed, outputKeys, outputPrefix } = remapJobOutput(item, fromKey, destKey);
    if (!changed) continue;
    const now = new Date().toISOString();
    const next = {
      ...item,
      outputKeys,
      updatedAt: now,
    };
    if (outputPrefix) next.outputPrefix = outputPrefix;
    await ddb.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: next,
    }));
    updated.push({
      jobId: item.jobId || String(item.pk || "").replace(/^JOB#/, ""),
      filename: item.filename || "",
      outputKeys,
      outputPrefix: next.outputPrefix || item.outputPrefix || "",
    });
  }
  return respond(200, { updated: updated.length, jobs: updated });
}

function jobIdOf(item) {
  return item.jobId || String(item.pk || "").replace(/^JOB#/, "");
}

async function deleteJobs(userId, body) {
  const jobId = String(body.jobId || "").trim();
  const keys = [];
  if (body.key) keys.push(ownedUserFileKey(userId, body.key));
  for (const raw of Array.isArray(body.keys) ? body.keys : []) {
    keys.push(ownedUserFileKey(userId, raw));
  }
  let prefix = "";
  if (body.prefix) {
    prefix = String(body.prefix).endsWith("/") ? String(body.prefix) : `${body.prefix}/`;
    if (!prefix.startsWith(`users/${userId}/`) || prefix.includes("..")) {
      const err = new Error("invalid key");
      err.statusCode = 403;
      throw err;
    }
  }
  if (!jobId && !keys.length && !prefix) {
    const err = new Error("jobId or key is required");
    err.statusCode = 400;
    throw err;
  }
  const items = await listUserJobItems(userId);
  const removed = [];
  const updated = [];
  const seen = new Set();

  async function wipe(item) {
    const id = jobIdOf(item);
    if (!id || seen.has(id)) return;
    seen.add(id);
    await wipeJob(userId, item);
    removed.push(id);
  }

  if (jobId) {
    const item = items.find((row) => jobIdOf(row) === jobId);
    if (!item) {
      const err = new Error("invalid job");
      err.statusCode = 404;
      throw err;
    }
    await wipe(item);
  }

  for (const key of keys) {
    for (const item of items) {
      const id = jobIdOf(item);
      if (seen.has(id)) continue;
      const cut = removeDeletedOutput(item, userId, key);
      if (!cut.matched) continue;
      if (cut.empty) {
        await wipe(item);
        continue;
      }
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: JOBS_TABLE,
        Item: { ...item, outputKeys: cut.outputKeys, updatedAt: now },
      }));
      updated.push({ jobId: id, filename: item.filename || "", outputKeys: cut.outputKeys });
      seen.add(id);
    }
  }

  if (prefix) {
    for (const item of items) {
      if (seen.has(jobIdOf(item))) continue;
      if (jobTouchesPrefix(item, userId, prefix)) await wipe(item);
    }
  }

  return respond(200, { removed, updated, jobs: updated });
}

async function wipeJob(userId, item) {
  await stopConvertTask(item);
  await deleteIngestPrefix(ingestPrefixForJob(userId, item));
  await ddb.send(new DeleteCommand({
    TableName: JOBS_TABLE,
    Key: { pk: item.pk || `JOB#${jobIdOf(item)}`, sk: item.sk || "META" },
  }));
}

function startedByForJob(jobId) {
  return `ready-${jobId}`.slice(0, 36);
}

async function stopConvertTask(item) {
  if (!CLUSTER_ARN) return;
  const arns = new Set();
  if (item.taskArn) arns.add(item.taskArn);
  try {
    const listed = await ecs.send(new ListTasksCommand({
      cluster: CLUSTER_ARN,
      startedBy: startedByForJob(jobIdOf(item)),
      desiredStatus: "RUNNING",
    }));
    for (const arn of listed.taskArns || []) arns.add(arn);
  } catch (err) {
    console.error("list convert tasks", err);
  }
  for (const task of arns) {
    try {
      await ecs.send(new StopTaskCommand({
        cluster: CLUSTER_ARN,
        task,
        reason: "User removed convert job",
      }));
    } catch (err) {
      const name = String(err?.name || "");
      if (name === "InvalidParameterException" || name === "ResourceNotFoundException") continue;
      console.error("stop convert task", task, err);
    }
  }
}

async function deleteIngestPrefix(prefix) {
  let token;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: INGEST_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    const objects = (listed.Contents || []).map((obj) => ({ Key: obj.Key })).filter((obj) => obj.Key);
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: INGEST_BUCKET,
        Delete: { Objects: objects, Quiet: true },
      }));
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  let uploadToken;
  do {
    const listed = await s3.send(new ListMultipartUploadsCommand({
      Bucket: INGEST_BUCKET,
      Prefix: prefix,
      KeyMarker: uploadToken?.KeyMarker,
      UploadIdMarker: uploadToken?.UploadIdMarker,
    }));
    for (const upload of listed.Uploads || []) {
      if (!upload.Key || !upload.UploadId) continue;
      await s3.send(new AbortMultipartUploadCommand({
        Bucket: INGEST_BUCKET,
        Key: upload.Key,
        UploadId: upload.UploadId,
      }));
    }
    uploadToken = listed.IsTruncated && (listed.NextKeyMarker || listed.NextUploadIdMarker)
      ? { KeyMarker: listed.NextKeyMarker, UploadIdMarker: listed.NextUploadIdMarker }
      : undefined;
  } while (uploadToken);
}

async function jobUploadProgress(userId, item) {
  const prefix = item.ingestKey || `incoming/${userId}/${item.jobId}/`;
  try {
    const listed = await s3.send(new ListMultipartUploadsCommand({
      Bucket: INGEST_BUCKET,
      Prefix: prefix,
    }));
    const uploads = [...(listed.Uploads || [])].sort((a, b) => (
      String(b.Initiated || "").localeCompare(String(a.Initiated || ""))
    ));
    const upload = uploads[0];
    if (!upload?.Key || !upload.UploadId) return null;
    const partsOut = await s3.send(new ListPartsCommand({
      Bucket: INGEST_BUCKET,
      Key: upload.Key,
      UploadId: upload.UploadId,
    }));
    const parts = partsOut.Parts || [];
    const bytes = parts.reduce((n, p) => n + Number(p.Size || 0), 0);
    const last = parts[parts.length - 1];
    return {
      file: String(upload.Key).split("/").pop() || "",
      parts: parts.length,
      bytes,
      lastAt: last?.LastModified ? new Date(last.LastModified).toISOString() : "",
    };
  } catch (err) {
    console.error("upload progress", err);
    return null;
  }
}

function quotedEtag(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith('"') ? raw : `"${raw.replaceAll('"', "")}"`;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    },
    body: JSON.stringify(body),
  };
}
