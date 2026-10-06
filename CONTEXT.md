# CONTEXT.md — video-convert-893
# Last updated: 2026-09-25

## What this repo is
Standalone add-on for cognito-s3-stack-893.
Ingest family DVD folders into a private S3 bucket, convert them with ffmpeg on Fargate, and drop MP4s into the existing Dropbox private bucket under `Videos/`.

## Part of the add-on family
| Repo | Description |
|------|-------------|
| `cognito-s3-stack-893` | Base: Cognito + S3 |
| `dropbox-893` | Private file manager — MP4s land in this bucket |
| `pdf-search-893` | OCR PDF search |
| `video-convert-893` | DVD / video ingest + convert + clip/combine — **this repo** |
| `dliv-web` | Personal dliv.com frontend |

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

## Structure
```
video-convert-893/
├── backend/
│   ├── bin/app.ts
│   ├── bin/config.ts            ← gitignored
│   ├── bin/config.example.ts
│   ├── lib/video-convert-stack.ts
│   ├── lambda/startJob/
│   ├── worker/                  ← Fargate ffmpeg image
│   └── scripts/deploy.sh ingest.sh
├── video_convert_outputs.json   ← gitignored
├── CONTEXT.md
└── README.md
```
