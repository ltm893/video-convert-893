import { test } from "node:test";
import assert from "node:assert/strict";
import { editTaskEnvironment, keysFromEvent, parseReadyKey, shouldSkipExisting } from "./handler.mjs";

test("CLI disc ready key writes shared Videos/", () => {
  assert.deepEqual(parseReadyKey("incoming/DVD-Video-Recording/ready"), {
    source: "cli",
    jobId: "DVD-Video-Recording",
    ingestPrefix: "incoming/DVD-Video-Recording/",
    outputPrefix: "Videos/",
  });
});

test("web ready key writes Mine Videos/", () => {
  const userId = "11111111-2222-3333-4444-555555555555";
  const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.deepEqual(parseReadyKey(`incoming/${userId}/${jobId}/ready`), {
    source: "web",
    userId,
    jobId,
    ingestPrefix: `incoming/${userId}/${jobId}/`,
    outputPrefix: `users/${userId}/Videos/`,
  });
});

test("clip and combine jobs pass source keys to ffmpeg", () => {
  const userId = "11111111-2222-3333-4444-555555555555";
  const source = `users/${userId}/Videos/Race.mp4`;
  assert.deepEqual(editTaskEnvironment({
    kind: "clip",
    sourceKeys: [source],
    clipStart: "0:01:30",
    clipEnd: "0:02:00",
  }), [
    { name: "EDIT_KIND", value: "clip" },
    { name: "SOURCE_KEYS", value: JSON.stringify([source]) },
    { name: "CLIP_START", value: "0:01:30" },
    { name: "CLIP_END", value: "0:02:00" },
  ]);
  assert.deepEqual(editTaskEnvironment({ kind: "file", sourceKeys: [source] }), []);
});

test("skip READY and fresh CONVERTING, rerun CONVERTING older than 4 hours", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  const fourHours = 4 * 60 * 60 * 1000;
  const fresh = new Date(now - 60 * 1000).toISOString();
  const exact = new Date(now - fourHours).toISOString();
  const older = new Date(now - fourHours - 1).toISOString();

  assert.equal(shouldSkipExisting("READY", fresh, now), true);
  assert.equal(shouldSkipExisting("READY", older, now), true);
  assert.equal(shouldSkipExisting("CONVERTING", fresh, now), true);
  assert.equal(shouldSkipExisting("CONVERTING", exact, now), true);
  assert.equal(shouldSkipExisting("CONVERTING", older, now), false);
});

test("event keys come from EventBridge, or from S3 records", () => {
  assert.deepEqual(keysFromEvent({
    detail: { object: { key: "incoming/Family/ready" } },
    Records: [{ s3: { object: { key: "incoming/Other/ready" } } }],
  }), ["incoming/Family/ready"]);
  assert.deepEqual(keysFromEvent({
    Records: [
      { s3: { object: { key: "incoming/A/ready" } } },
      { s3: { object: {} } },
      { s3: { object: { key: "incoming/B/ready" } } },
    ],
  }), ["incoming/A/ready", "incoming/B/ready"]);
});

test("rejects incomplete or nested ready keys", () => {
  assert.equal(parseReadyKey("incoming/ready"), null);
  assert.equal(parseReadyKey("incoming/a/b/c/ready"), null);
  assert.equal(parseReadyKey("Videos/foo/ready"), null);
  assert.equal(parseReadyKey("incoming/../job/ready"), null);
});
