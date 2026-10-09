import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingestPrefixForJob,
  jobMatchesDeletedFile,
  jobsToSupersede,
  jobTouchesPrefix,
  nextCdAlbumPrefix,
  ownedUserFileKey,
  ownedUserPrefix,
  parseOwnedKey,
  removeDeletedOutput,
  remapJobOutput,
  replaceOutputKey,
  safeRelPath,
  buildEditPlan,
  parseMediaTimestamp,
  formatMediaTimestamp,
} from "./paths.mjs";

const userId = "11111111-2222-3333-4444-555555555555";
const jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("owned disc keys may be nested under the job prefix", () => {
  const parsed = parseOwnedKey(userId, `incoming/${userId}/${jobId}/VIDEO_TS/VTS_01_1.VOB`);
  assert.equal(parsed.jobId, jobId);
  assert.equal(parsed.filename, "VTS_01_1.VOB");
  assert.equal(parsed.prefix, `incoming/${userId}/${jobId}/`);
  assert.equal(safeRelPath("VIDEO_TS/VTS_01_1.VOB"), "VIDEO_TS/VTS_01_1.VOB");
  assert.equal(safeRelPath("01 Audio Track.aiff"), "01-Audio-Track.aiff");
});

test("rejects path traversal in disc keys", () => {
  assert.throws(() => parseOwnedKey(userId, `incoming/${userId}/${jobId}/../secret`));
  assert.throws(() => safeRelPath("VIDEO_TS/../etc/passwd"));
  assert.throws(() => safeRelPath("VIDEO_TS/readme.txt"));
});

test("owned output keys stay under the user prefix", () => {
  const key = `users/${userId}/Videos/TrentonHS.mp4`;
  assert.equal(ownedUserFileKey(userId, key), key);
  assert.throws(() => ownedUserFileKey(userId, "Videos/TrentonHS.mp4"));
  assert.throws(() => ownedUserFileKey(userId, `users/${userId}/Videos/`));
  assert.throws(() => ownedUserFileKey(userId, `users/${userId}/Videos/../secret.mp4`));
});

test("replaceOutputKey rewrites only the matching mp4 and leaves the job name alone", () => {
  const fromKey = `users/${userId}/Videos/TrentonHS.mp4`;
  const destKey = `users/${userId}/Videos/Camping.mp4`;
  const out = replaceOutputKey([fromKey, `users/${userId}/Videos/other.mp4`], fromKey, destKey);
  assert.equal(out.changed, true);
  assert.deepEqual(out.outputKeys, [destKey, `users/${userId}/Videos/other.mp4`]);
  assert.equal(replaceOutputKey([fromKey], "missing", destKey).changed, false);
});

test("remapJobOutput updates a job matched by original upload name when keys are stale", () => {
  const fromKey = `users/${userId}/Videos/Wenner02.mp4`;
  const destKey = `users/${userId}/Videos/FamilyTrip.mp4`;
  const out = remapJobOutput({
    filename: "Wenner02",
    disc: "Wenner02",
    outputKeys: [],
  }, fromKey, destKey);
  assert.equal(out.changed, true);
  assert.deepEqual(out.outputKeys, [destKey]);
});

test("deleting the converted mp4 matches the job even after the S3 object is gone", () => {
  const key = `users/${userId}/Videos/TomHeldVideos.mp4`;
  const job = {
    jobId,
    filename: "TomHeldVideos",
    disc: "TomHeldVideos",
    ingestKey: `incoming/${userId}/${jobId}/`,
    outputKeys: [key],
  };
  assert.equal(jobMatchesDeletedFile(job, userId, key), true);
  const cut = removeDeletedOutput(job, userId, key);
  assert.equal(cut.empty, true);
  assert.equal(ingestPrefixForJob(userId, job), `incoming/${userId}/${jobId}/`);
  assert.equal(jobTouchesPrefix(job, userId, `users/${userId}/Videos/`), true);
  assert.equal(jobTouchesPrefix(job, userId, `users/${userId}/Photos/`), false);
});

test("removing one title mp4 keeps the job when other outputs remain", () => {
  const keep = `users/${userId}/Videos/Family-title02.mp4`;
  const gone = `users/${userId}/Videos/Family-title01.mp4`;
  const cut = removeDeletedOutput({
    filename: "Family",
    outputKeys: [gone, keep],
  }, userId, gone);
  assert.equal(cut.empty, false);
  assert.deepEqual(cut.outputKeys, [keep]);
});

test("renaming a Music CD folder rewrites outputPrefix and every track key", () => {
  const fromPrefix = `users/${userId}/Music/CD20261001-1/`;
  const destPrefix = `users/${userId}/Music/1973-Rupert-Held-Phone/`;
  const out = remapJobOutput({
    filename: "TomHeldAudio",
    outputPrefix: fromPrefix,
    outputKeys: [`${fromPrefix}01-Audio-Track.mp3`, `${fromPrefix}02-Audio-Track.mp3`],
  }, fromPrefix, destPrefix);
  assert.equal(out.changed, true);
  assert.equal(out.outputPrefix, destPrefix);
  assert.deepEqual(out.outputKeys, [
    `${destPrefix}01-Audio-Track.mp3`,
    `${destPrefix}02-Audio-Track.mp3`,
  ]);
  assert.equal(ownedUserPrefix(userId, fromPrefix), fromPrefix);
  assert.throws(() => ownedUserPrefix(userId, `users/${userId}/Music/`));
  assert.throws(() => ownedUserFileKey(userId, fromPrefix));
});

test("audio converts land in a dated CD folder under Music", () => {
  const now = new Date("2026-10-01T23:30:00Z");
  const root = `users/${userId}/Music/`;
  assert.equal(nextCdAlbumPrefix(root, [], now), `${root}CD20261001-1/`);
  assert.equal(
    nextCdAlbumPrefix(root, [`${root}CD20261001-1/`, `${root}CD20261001-1/01-Audio-Track.mp3`], now),
    `${root}CD20261001-2/`,
  );
  assert.equal(
    nextCdAlbumPrefix(root, ["users/other/Music/CD20261001-9/"], now),
    `${root}CD20261001-1/`,
  );
});

test("clip and combine plans stay inside Mine Videos and keep the sources", () => {
  const race = `users/${userId}/Videos/Race.mp4`;
  const clip = buildEditPlan(userId, {
    kind: "clip",
    sourceKey: race,
    start: "1:30",
    end: "2:00",
    name: "Race highlight",
  });
  assert.equal(clip.kind, "clip");
  assert.equal(clip.clipStart, "0:01:30");
  assert.equal(clip.clipEnd, "0:02:00");
  assert.equal(clip.filename, "Race-highlight.mp4");
  assert.equal(clip.outputKey, `users/${userId}/Videos/Race-highlight.mp4`);
  assert.deepEqual(clip.sourceKeys, [race]);

  const nested = `users/${userId}/Videos/trips/Lake.m4v`;
  const nestedClip = buildEditPlan(userId, { kind: "clip", sourceKey: nested, start: "10", end: "20" });
  assert.equal(nestedClip.outputPrefix, `users/${userId}/Videos/trips/`);
  assert.equal(nestedClip.filename, "Lake-clip.mp4");

  const combined = buildEditPlan(userId, {
    kind: "combine",
    sourceKeys: [race, `users/${userId}/Videos/clips/Second.mp4`],
    name: "Weekend",
  });
  assert.equal(combined.outputPrefix, `users/${userId}/Videos/`);
  assert.equal(combined.outputKey, `users/${userId}/Videos/Weekend.mp4`);

  assert.throws(() => buildEditPlan(userId, { kind: "clip", sourceKey: `users/${userId}/Photos/a.mp4`, start: "0", end: "1" }), /Mine/);
  assert.throws(() => buildEditPlan(userId, { kind: "clip", sourceKey: race, start: "5", end: "1", name: "nope" }), /after the start/);
  assert.throws(() => buildEditPlan(userId, { kind: "clip", sourceKey: race, start: "0", end: "1", name: "Race" }), /new file name/);
  assert.throws(() => buildEditPlan(userId, { kind: "combine", sourceKeys: [race], name: "One" }), /at least two/);
});

test("clip times format to the H:MM:SS string Fargate receives", () => {
  const formatted = [
    ["90", "0:01:30"],
    ["1:30.5", "0:01:30.5"],
    ["0:01:30.5", "0:01:30.5"],
    ["1:02:15", "1:02:15"],
  ];
  for (const [raw, expected] of formatted) {
    assert.equal(formatMediaTimestamp(parseMediaTimestamp(raw)), expected);
  }
  const race = `users/${userId}/Videos/Race.mp4`;
  const plan = buildEditPlan(userId, {
    kind: "clip",
    sourceKey: race,
    start: "1:30.5",
    end: "1:02:15",
  });
  assert.equal(plan.clipStart, "0:01:30.5");
  assert.equal(plan.clipEnd, "1:02:15");

  assert.throws(() => parseMediaTimestamp("1:60"), /1:30/);
  assert.throws(() => parseMediaTimestamp(""), /start and end/);
  assert.throws(() => parseMediaTimestamp("-1"), /out of range/);
  assert.throws(() => parseMediaTimestamp("24:00:01"), /out of range/);
});

test("a queued edit is not superseded by an older file with the same name", () => {
  const gone = jobsToSupersede([
    { jobId: "clip", filename: "Race-highlight.mp4", status: "QUEUED", createdAt: "2026-10-05T14:00:00Z" },
    { jobId: "old", filename: "Race-highlight", status: "READY", createdAt: "2026-10-01T10:00:00Z" },
  ]);
  assert.deepEqual(gone, []);
});

test("after a successful re-convert, only the older same-name job is superseded", () => {
  const gone = jobsToSupersede([
    { jobId: "new", filename: "CampingDragRacing", status: "READY", createdAt: "2026-09-30T10:00:00Z" },
    { jobId: "old", filename: "CampingDragRacing", status: "READY", createdAt: "2026-09-28T10:00:00Z" },
    { jobId: "busy", filename: "TrentonHS", status: "CONVERTING", createdAt: "2026-09-30T11:00:00Z" },
    { jobId: "busy-old", filename: "TrentonHS", status: "READY", createdAt: "2026-09-29T10:00:00Z" },
  ]);
  assert.deepEqual(gone.map((job) => job.jobId), ["old"]);
});
