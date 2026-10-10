# video-convert-893 — testing guide

Last updated: 2026-10-10

One command runs the suite on a laptop. The sections below list what that suite already checks, then the cases to add next. The suite does not call AWS, ffmpeg, or `deploy.sh`.

---

## Running tests

### Script (recommended)

```bash
./run_tests.sh
```

Runs the five unit-test files and prints a pass/fail line per file. Exits with code `1` if any file fails.

The script:

- Needs Node.js 20+ and Python 3.12 (3.11+ is enough locally)
- Runs `npm ci --omit=dev` in `backend/lambda/startJob` and `backend/lambda/uploadApi` the first time, because each `handler.mjs` imports the AWS SDK at load time
- Leaves that `node_modules` in place for the next run
- Does not read `backend/bin/config.ts` or `video_convert_outputs.json`

GitHub Actions runs the same script on every push to `dev` or `main`, and on pull requests. The workflow is `.github/workflows/test.yml`.

### Direct

```bash
node --test backend/lambda/startJob/parseReadyKey.test.mjs
node --test backend/lambda/uploadApi/paths.test.mjs
node --test backend/lambda/uploadApi/handler.test.mjs
python3 backend/worker/convert_test.py
python3 backend/scripts/test_detect.py
```

`parseReadyKey.test.mjs` needs `backend/lambda/startJob/node_modules` first (`npm ci --omit=dev` in that directory). `handler.test.mjs` needs the same install in `backend/lambda/uploadApi`.

---

## Test framework

| Area | Runner | Assertion |
|------|--------|-----------|
| Lambda | `node --test` (`node:test`) | `node:assert/strict` |
| Worker | `python3` `unittest` | `self.assertEqual` / `self.assertRaises` |

There is no Jest, pytest, or CDK assertion library. New tests stay in these two runners so `./run_tests.sh` keeps being the only command.

---

## What is tested

### Ready key and edit env (5 tests)

`backend/lambda/startJob/parseReadyKey.test.mjs`

| Test | What it checks |
|------|----------------|
| CLI disc ready key | `incoming/{job}/ready` → shared `Videos/` |
| Web ready key | `incoming/{user}/{job}/ready` → `users/{user}/Videos/` |
| Clip and combine env | `EDIT_KIND`, `SOURCE_KEYS`, `CLIP_START`, `CLIP_END`; a file job adds no edit env |
| Incomplete or nested keys | `incoming/ready`, four extra segments, a `Videos/` key, and `..` all return null |
| Skip existing job | `READY` and `CONVERTING` at or under 4 hours are skipped. `CONVERTING` older than 4 hours runs again |

### Upload API responses (3 tests)

`backend/lambda/uploadApi/handler.test.mjs`

These return before any S3 or DynamoDB call.

| Test | What it checks |
|------|----------------|
| Missing or short Cognito sub | No `sub`, or a `sub` shorter than 8 characters, is 401 `Unauthorized` |
| Body that is not JSON | `POST /uploads` with `{` is 400 `invalid JSON` |
| Unknown path | A known user and `GET /nope` is 404 `Not found` |

### Upload paths (14 tests)

`backend/lambda/uploadApi/paths.test.mjs`

| Test | What it checks |
|------|----------------|
| Owned disc keys | Nested `VIDEO_TS` keys stay inside the job prefix; spaces in audio names become hyphens |
| Path traversal | `../` and a non-disc filename are rejected |
| Owned output keys | Mine file keys stay under `users/{id}/`; shared `Videos/`, a prefix, and `..` are rejected |
| `replaceOutputKey` | Only the matching MP4 is rewritten |
| `remapJobOutput` | A job matched by the original upload name still remaps when `outputKeys` is empty |
| Deleted converted MP4 | The job matches after the object is gone; an empty output list marks the job empty; Photos is not Videos |
| One title removed | The job stays when another title MP4 remains |
| Music folder rename | `outputPrefix` and every track key move together; `Music/` itself is not a file key |
| Dated CD folder | `CD{yyyymmdd}-N` increments inside that user's Music prefix only |
| Clip and combine plan | Times become `H:MM:SS`, the new file stays beside the source or under Videos, and bad ranges, names, and photo keys throw |
| Clip time format | `90` → `0:01:30`, `1:30.5` → `0:01:30.5` on the plan Fargate receives; `1:60`, empty, `-1`, and `24:00:01` are rejected |
| Queued edit | A `QUEUED` job in `jobs-to-supersede.json` is not superseded by an older file with the same name |
| Re-convert | After a successful re-convert, only the older `READY` row with the same name is superseded |
| Same timestamp | Two `READY` rows with the same `createdAt` keep the greater `jobId` (`job-b` stays, `job-a` goes) |

### Worker plan (12 tests)

`backend/worker/convert_test.py`

| Test | What it checks |
|------|----------------|
| Audio folder | `.aiff` tracks become numbered `.mp3` names, sorted 1, 2, 10 |
| VIDEO_TS wins | A disc with both VOBs and audio is a video job |
| Dated CD folder | Audio lands in `Music/CD{date}-N/`, and a prefix that is already an album is left alone |
| Clip command | Source keys stay under Mine Videos; ffmpeg times are passed through; a `;` in a time is rejected; silent vs loud normalize commands differ |
| Formatted clip times | `0:01:30`, `0:01:30.5`, and `1:02:15` pass `safe_ffmpeg_time`. Raw `1:30.5` is rejected here; raw `24:00:01` is accepted here |
| Audio command | `.mp3` uses `-c:a copy`. `.wav` and `.aiff` use `libmp3lame`, `192k`, and a title tag. ffmpeg is not run |
| Concat list | A quote in a path is escaped; the combine command uses the concat demuxer and `libx264` |
| Queued edit | Same `queuedEdit` row as the Lambda fixture |
| Re-convert | Same `reconvert` row as the Lambda fixture |
| Same timestamp | Same `sameTimestamp` row as the Lambda fixture |
| Conversion log key | The log object is `conversion-log/{user}/{job}.json`, outside `incoming/` |
| Conversion record | A ready record lists the output MP4 keys |

### Disc detect (10 tests)

`backend/scripts/test_detect.py`

| Test | What it checks |
|------|----------------|
| Slug | `"DVD Video Recording"` → `DVD-Video-Recording`; blank → `disc` |
| One VOB title | Menu VOB is dropped; the large parts are one concat output |
| Two titles | `VTS_01` and `VTS_02` become `title01` and `title02` |
| VIDEO_TS over VIDEO_RM | A usable VOB wins over DVD-VR |
| DVD-VR fallback | Menu-only VIDEO_TS falls through to `VIDEO_RM.DAT` |
| Loose MP4 | A large `.mp4` is a file job named after the disc |
| Small web MP4 | A 20 KB `.mov` is above the 10 KB loose-file floor, so it is a file job named after the disc |
| CSS hint | `Encrypted` / CSS wording is recognized; a normal ffmpeg progress line is not |
| Concat protocol | Two VOB parts use `concat:`; one part is a plain `-i` |
| Supersede fixture | Every row in `jobs-to-supersede.json`, including the same-timestamp `jobId` tie-break |

---

## What to add next

Ordered by what breaks a family disc or a Mine edit if it drifts. Each item stays inside `./run_tests.sh`. None of them need a bucket, a user pool, or a Fargate task.

### 1. startJob event keys and a failed RunTask

`shouldSkipExisting` is tested. The handler around it still owns the rest of the ready-marker path:

- `RunTask` returns no tasks → job row `FAILED` with the failure reason
- EventBridge `detail.object.key` and an S3 `Records[]` event both yield the object key
- `+` in the key is a space before parse

Pull `keysFromEvent` out and test it in `parseReadyKey.test.mjs`. The failure row still needs a fake DynamoDB and ECS client, so leave that until the key helper is out.

---

## What stays manual

These need the real account, a mounted disc, or a long ffmpeg encode. They stay off `./run_tests.sh` and off GitHub Actions.

| Check | When |
|-------|------|
| `./scripts/deploy.sh` | After a stack change. Docker builds the Fargate image. |
| `./scripts/ingest.sh "/Volumes/…"` | A real home-recorded disc on the Mac. |
| One clip and one combine from dliv | After an API or worker change, against Mine → Videos. |
| CSS commercial disc | Confirm the worker marks the job `FAILED` and leaves the private bucket alone. |
| CDK synth | `config.ts` is gitignored, so a snapshot of the template is a local check, not a CI artifact. |

A live smoke script in the style of `dropbox-893` `verify.sh` fits a GET-only API. A convert here starts Fargate. Keep that for a disc you meant to convert.

---

## Adding new tests

1. Lambda rules that do not call AWS go in `backend/lambda/uploadApi/paths.test.mjs`, `backend/lambda/uploadApi/handler.test.mjs`, or `backend/lambda/startJob/parseReadyKey.test.mjs`.
2. Disc layout and ffmpeg argument lists go in `backend/worker/convert_test.py` or `backend/scripts/test_detect.py`.
3. Build a temp directory of small files. The detect tests use `1_500_000` bytes so a VOB counts as a title, and `20_000` bytes for a web upload.
4. Run `./run_tests.sh`.

### Example

```javascript
test("seconds-only clip start becomes H:MM:SS", () => {
  const plan = buildEditPlan(userId, {
    kind: "clip",
    sourceKey: `users/${userId}/Videos/Race.mp4`,
    start: "90",
    end: "100",
  });
  assert.equal(plan.clipStart, "0:01:30");
});
```

---

## Test file locations

| File | Purpose |
|------|---------|
| `run_tests.sh` | CLI runner. Same command locally and in Actions |
| `.github/workflows/test.yml` | Runs `./run_tests.sh` on `dev`, `main`, and pull requests |
| `backend/lambda/startJob/parseReadyKey.test.mjs` | Ready-key parse and edit task env |
| `backend/lambda/uploadApi/handler.test.mjs` | 401, 400, and 404 responses that return before AWS |
| `backend/fixtures/jobs-to-supersede.json` | Shared supersede rows for the Lambda and the worker |
| `backend/lambda/uploadApi/paths.test.mjs` | Keys, remap, CD folders, clip/combine plan, supersede |
| `backend/worker/convert_test.py` | Audio plan, clip/combine commands, conversion log |
| `backend/scripts/test_detect.py` | DVD / DVD-VR / loose-file detect |
| `TESTING.md` | This file |
