# video-convert-893

CDK add-on that converts **family DVDs and videos** with ffmpeg on Fargate and writes MP4s into the existing Dropbox private bucket. Same pattern as **`pdf-search-893`**: ingest on the Mac or in the browser, AWS does the heavy work.

The physical disc still has to be read on your Mac. AWS cannot see the drive.

Amplify is **not** used for this backend — run **`deploy.sh`**. **`dliv-web`** is the consumer (`VIDEO_CONVERT_API_URL`).

## Repo family

Full map: [cognito-s3-stack-893](https://github.com/ltm893/cognito-s3-stack-893#repo-family).

| Repo | How this stack uses it |
|------|------------------------|
| `cognito-s3-stack-893` | Existing user pool |
| `dropbox-893` | Private bucket where finished MP4s are written |
| `dliv-web` | Website that calls this API (`VIDEO_CONVERT_API_URL`) |

## What this deploys

- Ingest bucket `{id}-video-ingest` (retained)
- DynamoDB `{id}-video-convert-jobs`
- Lambda **startJob** — Object Created `…/ready` → ECS RunTask
- Lambda **uploadApi** — Cognito-protected REST API
- Fargate ffmpeg worker
- CloudWatch `/ecs/{id}-video-convert`

Imported only (never created or deleted): Cognito User Pool and the Dropbox **private** bucket.

## Features

- `ingest.sh /Volumes/SomeDisc` syncs a disc, then writes a `ready` marker
- One Fargate job per disc (not one job per `.VOB`)
- Detects `VIDEO_TS`, DVD-VR (`VIDEO_RM` / `.VRO`), or already-made video files
- CLI discs → `s3://{privateBucket}/Videos/{name}.mp4`
- Web uploads → `s3://{privateBucket}/users/{sub}/Videos/`
- **Clip** — extract a time range from an MP4 already in Mine → Videos
- **Combine** — join MP4s already in Mine → Videos into one new file
- Deletes the ingest prefix after a successful convert
- Home recordings only — CSS-encrypted commercial DVDs are skipped

## API (Cognito JWT)

| Method | Path | Role |
|--------|------|------|
| `GET` | `/jobs` | List convert jobs |
| `PATCH` | `/jobs` | Remap job output keys |
| `DELETE` | `/jobs` | Remove job rows |
| `POST` | `/uploads` | Start a web/disc upload |
| `POST` | `/uploads/parts` | Presigned UploadPart URLs |
| `POST` | `/uploads/complete` | Finish a part |
| `POST` | `/uploads/abort` | Abort a part |
| `POST` | `/uploads/ready` | Mark the ingest prefix ready (starts Fargate) |
| `POST` | `/edits` | Queue a clip or combine (`kind`: `clip` or `combine`) |

Set Amplify env var **`VIDEO_CONVERT_API_URL`** to `api.base_url` from `video_convert_outputs.json`.

## Deploy

```bash
cd backend
cp bin/config.example.ts bin/config.ts
# set id, awsRegion, userPoolId, privateBucket
./scripts/deploy.sh
```

Docker is required on the deploy machine (Fargate image build). `deploy.sh` writes **`video_convert_outputs.json`** at the repo root (gitignored).

## Ingest a disc (CLI)

```bash
./scripts/ingest.sh "/Volumes/DVD Video Recording"
```

Eject, next disc. The MP4 shows up in dliv **Dropbox → All DLIV Users → Videos**.

## Tests

```bash
./run_tests.sh
```

55 tests. Handlers stub DynamoDB, S3, and ECS. The worker fakes S3 and checks ffmpeg argument lists without running ffmpeg. What each test covers, and what still needs a real account or a disc, is in [TESTING.md](./TESTING.md). GitHub Actions runs the same script on `dev`, `main`, and pull requests.

## Job statuses

`UPLOADING` or `QUEUED` → `CONVERTING` → `READY` or `FAILED` (DynamoDB `{id}-video-convert-jobs`).

## Layout

| Path | Role |
|------|------|
| `backend/bin/config.example.ts` | Template — copy to `config.ts` |
| `backend/bin/config.ts` | Local only — gitignored |
| `backend/lib/video-convert-stack.ts` | Stack |
| `backend/lambda/startJob` | Ready marker → RunTask |
| `backend/lambda/uploadApi` | Web API |
| `backend/worker` | Fargate ffmpeg image |
| `backend/scripts/deploy.sh` | Deploy + write outputs |
| `backend/scripts/ingest.sh` | Sync a mounted disc |
| `backend/fixtures/jobs-to-supersede.json` | Shared supersede cases for the Lambda and the worker |
| `backend/lambda/awsMock.mjs` | Stubs `client.send` in the handler tests |
| `run_tests.sh` | 55 tests. Stubs AWS. Does not run ffmpeg |
| `.github/workflows/test.yml` | Runs `./run_tests.sh` |
| `TESTING.md` | What the suite covers and what stays manual |
| `CONTEXT.md` | Maintainer notes |

## Security

- Do not commit `backend/bin/config.ts` or `video_convert_outputs.json`.
- The User Pool is imported; this stack does not create a new app client.
