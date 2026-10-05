import { test } from "node:test";
import assert from "node:assert/strict";
import { editTaskEnvironment, parseReadyKey } from "./handler.mjs";

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

test("rejects incomplete or nested ready keys", () => {
  assert.equal(parseReadyKey("incoming/ready"), null);
  assert.equal(parseReadyKey("incoming/a/b/c/ready"), null);
  assert.equal(parseReadyKey("Videos/foo/ready"), null);
  assert.equal(parseReadyKey("incoming/../job/ready"), null);
});
