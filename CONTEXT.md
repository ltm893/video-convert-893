# CONTEXT.md — video-convert-893
# Last updated: 2026-10-10

## What this repo is
Standalone add-on for cognito-s3-stack-893.
Ingest family DVD folders into a private S3 bucket, convert them with ffmpeg on Fargate, and drop MP4s into the existing Dropbox private bucket under `Videos/`.

## Part of the add-on family
Full map: [cognito-s3-stack-893](https://github.com/ltm893/cognito-s3-stack-893#repo-family). This stack uses the Cognito user pool, writes MP4s into the `dropbox-893` private bucket, and is called by `dliv-web` through `VIDEO_CONVERT_API_URL`.

## What this stack owns
- S3 ingest bucket (`{id}-video-ingest`, retained)
- DynamoDB jobs table (`{id}-video-convert-jobs`)
- Lambda: **startJob** — Object Created `.../ready` → ECS RunTask
- Lambda: **uploadApi** — Cognito REST API (`/jobs`, `/uploads`, `/edits`)
- ECS cluster + Fargate ffmpeg task
- CloudWatch log group `/ecs/{id}-video-convert`

## What this stack imports (never creates or deletes)
- Cognito User Pool — from `config.ts` (same family pool; no extra app client)
- S3 private Dropbox bucket — from `config.ts` (`Videos/` prefix only)

## Personal deployment (dliv.com)
- Stack: `VideoConvertStack-videoconvert893`
- User Pool: same pool as dropbox-893
- Output bucket: `dliv-private-files` prefix `Videos/`

## Deploy
```bash
cd backend
cp bin/config.example.ts bin/config.ts
# edit config.ts
./scripts/deploy.sh
./scripts/ingest.sh "/Volumes/DVD Video Recording"
```

Writes `video_convert_outputs.json` at repo root (gitignored).

## Tests

```bash
./run_tests.sh
```

55 tests. No live AWS account, no ffmpeg binary, no `deploy.sh`. Details are in `TESTING.md`.

- `node:test` for the Lambdas. `awsMock.mjs` replaces `client.send` for startJob and uploadApi.
- `unittest` for the worker and disc detect. S3 download and delete use a fake client. ffmpeg is checked as an argument list.
- `backend/fixtures/jobs-to-supersede.json` is the one supersede list. The Lambda, the worker, and disc detect all read it.
- Clip times are asserted as the formatted string Fargate receives (`1:30.5` → `0:01:30.5`).
- GitHub Actions (`.github/workflows/test.yml`) runs `./run_tests.sh` on `dev`, `main`, and pull requests.

Presigned part URLs, `deploy.sh`, `ingest.sh`, and a real encode stay manual.

## Structure
```
video-convert-893/
├── backend/
│   ├── bin/app.ts
│   ├── bin/config.ts            ← gitignored
│   ├── bin/config.example.ts
│   ├── lib/video-convert-stack.ts
│   ├── fixtures/jobs-to-supersede.json
│   ├── lambda/awsMock.mjs
│   ├── lambda/startJob/         ← handler plus parseReadyKey and handler tests
│   ├── lambda/uploadApi/        ← paths and handler tests
│   ├── worker/                  ← Fargate image, convert.py, convert_test.py
│   └── scripts/deploy.sh ingest.sh test_detect.py
├── run_tests.sh
├── TESTING.md
├── .github/workflows/test.yml
├── video_convert_outputs.json   ← gitignored
├── CONTEXT.md
└── README.md
```
