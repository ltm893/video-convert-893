# video-convert-893

CDK add-on that copies a **family DVD folder** into S3 and converts it to an MP4 in the existing Dropbox bucket (`Videos/`). Same pattern as **`pdf-search-893`**: ingest on the Mac, AWS does the heavy work.

The physical disc still has to be read on your Mac. AWS cannot see the drive.

## Features

- `ingest.sh /Volumes/SomeDisc` syncs the disc, then writes a `ready` marker
- Object Created on `incoming/{name}/ready` starts one Fargate ffmpeg job (not one job per `.VOB`)
- Detects `VIDEO_TS` titles, DVD-VR (`VIDEO_RM` / `.VRO`), or already-made video files
- Writes `s3://{privateBucket}/Videos/{name}.mp4` (`Content-Type: video/mp4`)
- Web clip: extract a time range from an MP4 already in Mine → Videos
- Web combine: join MP4s already in Mine → Videos into one new file
- Deletes the ingest prefix after a successful convert
- Home recordings only — CSS-encrypted commercial DVDs are skipped

## Deploy

```bash
cd backend
cp bin/config.example.ts bin/config.ts
# set id, awsRegion, userPoolId, privateBucket
./scripts/deploy.sh
```

Docker is required on the deploy machine (Fargate image build).

## Ingest a disc

```bash
./scripts/ingest.sh "/Volumes/DVD Video Recording"
```

Eject, next disc. The MP4 shows up in dliv **Dropbox → All DLIV Users → Videos**.

## Job statuses

`UPLOADED` → `CONVERTING` → `READY` or `FAILED` (DynamoDB `{id}-video-convert-jobs`).
