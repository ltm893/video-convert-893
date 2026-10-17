#!/usr/bin/env python3
"""Download a disc prefix from S3, convert video to MP4 or audio to MP3."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

VIDEO_EXTS = {
    ".mp4", ".m4v", ".mov", ".mpg", ".mpeg", ".avi", ".mkv",
    ".wmv", ".m2ts", ".mts", ".vro", ".vob",
}
AUDIO_EXTS = {
    ".aiff", ".aif", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".mp3",
}
MIN_TITLE_BYTES = 1_000_000
MIN_LOOSE_BYTES = 10_000
CSS_HINTS = (
    "css",
    "encrypted",
    "copy protection",
    "scrambled",
    "libdvdcss",
    "dvdnav",
)


def log(*parts):
    print(*parts, flush=True)


def slug_filename(name: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "").strip())
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text or "disc"


def find_named_dir(root: Path, name: str) -> Path | None:
    want = name.lower()
    matches = [p for p in root.rglob("*") if p.is_dir() and p.name.lower() == want]
    if not matches:
        return None
    matches.sort(key=lambda p: (len(p.parts), str(p).lower()))
    return matches[0]


def vob_title_groups(video_ts: Path) -> list[tuple[str, list[Path]]]:
    groups: dict[str, list[tuple[int, Path]]] = {}
    for path in video_ts.iterdir() if video_ts.is_dir() else []:
        m = re.match(r"^VTS_(\d+)_([1-9]\d*)\.VOB$", path.name, re.I)
        if not m or path.stat().st_size < MIN_TITLE_BYTES:
            continue
        title, part = m.group(1), int(m.group(2))
        groups.setdefault(title, []).append((part, path))
    out = []
    for title in sorted(groups, key=lambda t: int(t)):
        parts = [p for _, p in sorted(groups[title], key=lambda row: row[0])]
        if parts:
            out.append((title, parts))
    return out


def find_dvdvr_sources(root: Path) -> list[Path]:
    vrm = find_named_dir(root, "VIDEO_RM")
    found: list[Path] = []
    search = [vrm] if vrm else []
    search.append(root)
    for folder in search:
        if not folder or not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if not path.is_file():
                continue
            lower = path.name.lower()
            if lower.endswith(".vro") and path.stat().st_size >= MIN_TITLE_BYTES:
                found.append(path)
            elif lower in ("video_rm.ifo", "vr_mangr.ifo") and path.stat().st_size > 0:
                found.append(path)
            elif lower.endswith(".dat") and path.stat().st_size >= MIN_TITLE_BYTES:
                found.append(path)
    # unique, prefer VRO then IFO then DAT
    uniq = []
    seen = set()
    for path in found:
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        uniq.append(path)
    return uniq


def find_loose_videos(root: Path) -> list[Path]:
    skip_dirs = {"video_ts", "video_rm"}
    files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part.lower() in skip_dirs for part in path.parts):
            continue
        if path.suffix.lower() in VIDEO_EXTS and path.stat().st_size >= MIN_LOOSE_BYTES:
            files.append(path)
    files.sort(key=lambda p: str(p).lower())
    return files


def audio_sort_key(path: Path) -> tuple:
    name = path.name
    m = re.match(r"^(\d+)", name)
    n = int(m.group(1)) if m else 10**9
    return (n, name.lower())


def find_loose_audio(root: Path) -> list[Path]:
    skip_dirs = {"video_ts", "video_rm"}
    files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part.lower() in skip_dirs for part in path.parts):
            continue
        if path.suffix.lower() in AUDIO_EXTS and path.stat().st_size >= MIN_LOOSE_BYTES:
            files.append(path)
    files.sort(key=audio_sort_key)
    return files


def music_root_of(prefix: str) -> str:
    p = prefix if str(prefix).endswith("/") else f"{prefix}/"
    if p.endswith("Videos/"):
        return f"{p[:-len('Videos/')]}Music/"
    match = re.search(r"^(.*?Music/)", p)
    if match:
        return match.group(1)
    return p


def audio_output_prefix(prefix: str, existing: list[str] | None = None, now: datetime | None = None) -> str:
    p = prefix if str(prefix).endswith("/") else f"{prefix}/"
    if p.endswith("Videos/"):
        p = f"{p[:-len('Videos/')]}Music/"
    album = p.rstrip("/").split("/")[-1]
    if re.fullmatch(r"CD\d{8}-\d+", album or ""):
        return p
    if p.endswith("Music/"):
        return next_cd_album_prefix(p, existing or [], now)
    return p


def cd_date_stamp(now: datetime | None = None) -> str:
    stamp = now or datetime.now(timezone.utc)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).strftime("%Y%m%d")


def next_cd_album_prefix(music_root: str, existing: list[str], now: datetime | None = None) -> str:
    root = music_root if str(music_root).endswith("/") else f"{music_root}/"
    stamp = cd_date_stamp(now)
    pat = re.compile(rf"^CD{re.escape(stamp)}-(\d+)$")
    used: set[int] = set()
    for raw in existing or []:
        text = str(raw or "")
        if "/" not in text.strip("/"):
            name = text.strip("/")
        elif text.startswith(root):
            name = text[len(root):].split("/")[0]
        else:
            continue
        match = pat.match(name)
        if match:
            used.add(int(match.group(1)))
    n = 1
    while n in used:
        n += 1
    return f"{root}CD{stamp}-{n}/"


def list_music_album_names(s3, bucket: str, music_root: str) -> list[str]:
    names: list[str] = []
    if not bucket or not music_root:
        return names
    root = music_root if music_root.endswith("/") else f"{music_root}/"
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=root, Delimiter="/"):
        for prefix in page.get("CommonPrefixes") or []:
            name = str(prefix.get("Prefix") or "").rstrip("/").split("/")[-1]
            if name:
                names.append(name)
    return names


def detect_jobs(root: Path, disc: str) -> dict:
    """Return {kind, outputs: [{name, inputs, concat}]} or {kind: none, reason}."""
    video_ts = find_named_dir(root, "VIDEO_TS")
    titles = vob_title_groups(video_ts) if video_ts else []
    if titles:
        if len(titles) == 1:
            outputs = [{"name": f"{disc}.mp4", "inputs": titles[0][1], "concat": True}]
        else:
            outputs = [
                {"name": f"{disc}-title{title}.mp4", "inputs": parts, "concat": True}
                for title, parts in titles
            ]
        return {"kind": "video_ts", "outputs": outputs}

    vr = find_dvdvr_sources(root)
    if vr:
        if len(vr) == 1:
            outputs = [{"name": f"{disc}.mp4", "inputs": vr, "concat": False}]
        else:
            outputs = [
                {"name": f"{disc}-{slug_filename(path.stem)}.mp4", "inputs": [path], "concat": False}
                for path in vr
            ]
        return {"kind": "dvd_vr", "outputs": outputs}

    loose = find_loose_videos(root)
    if loose:
        if len(loose) == 1:
            outputs = [{"name": f"{disc}.mp4", "inputs": loose, "concat": False}]
        else:
            outputs = [
                {"name": f"{disc}-{slug_filename(path.stem)}.mp4", "inputs": [path], "concat": False}
                for path in loose
            ]
        return {"kind": "files", "outputs": outputs}

    audio = find_loose_audio(root)
    if audio:
        outputs = []
        for path in audio:
            stem = slug_filename(path.stem)
            outputs.append({
                "name": f"{stem}.mp3",
                "inputs": [path],
                "concat": False,
                "audio": True,
            })
        return {"kind": "audio", "outputs": outputs}

    return {"kind": "none", "reason": "No VIDEO_TS titles, DVD-VR files, video files, or audio files found."}


def ffmpeg_error_is_css(stderr: str) -> bool:
    text = (stderr or "").lower()
    return any(hint in text for hint in CSS_HINTS)


def ffmpeg_input_args(inputs: list[Path], concat: bool) -> list[str]:
    # MPEG-PS VOB parts are one title split at 1GB. concat: keeps a continuous
    # stream; the concat demuxer often stops after VTS_xx_1.VOB.
    if concat and len(inputs) > 1:
        return ["-i", "concat:" + "|".join(str(path) for path in inputs)]
    return ["-i", str(inputs[0])]


def run_ffmpeg(inputs: list[Path], output: Path, concat: bool) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    src = ffmpeg_input_args(inputs, concat)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-fflags", "+genpts",
        *src,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output),
    ]
    log("ffmpeg", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode == 0 and output.exists() and output.stat().st_size > 0:
        return
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    if ffmpeg_error_is_css(combined):
        raise RuntimeError("This looks like a CSS-encrypted commercial DVD. Home recordings only.")
    retry_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-fflags", "+genpts",
        *src,
        "-map", "0:v:0", "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-movflags", "+faststart",
        str(output),
    ]
    log("ffmpeg retry without audio")
    proc2 = subprocess.run(retry_cmd, capture_output=True, text=True)
    if proc2.returncode == 0 and output.exists() and output.stat().st_size > 0:
        return
    err = (proc.stderr or proc2.stderr or "ffmpeg failed").strip().splitlines()
    raise RuntimeError("\n".join(err[-8:]) if err else "ffmpeg failed")


def ffmpeg_audio_commands(src: Path, output: Path) -> list[list[str]]:
    title = src.stem
    encode = [
        "ffmpeg", "-y", "-hide_banner", "-i", str(src),
        "-map", "0:a:0",
        "-c:a", "libmp3lame", "-b:a", "192k",
        "-id3v2_version", "3",
        "-metadata", f"title={title}",
        str(output),
    ]
    if src.suffix.lower() != ".mp3":
        return [encode]
    copy = [
        "ffmpeg", "-y", "-hide_banner", "-i", str(src),
        "-map", "0:a:0", "-c:a", "copy",
        str(output),
    ]
    return [copy, encode]


def run_ffmpeg_audio(inputs: list[Path], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    last_err = "ffmpeg audio failed"
    for cmd in ffmpeg_audio_commands(inputs[0], output):
        log("ffmpeg", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0 and output.exists() and output.stat().st_size > 0:
            return
        err = (proc.stderr or "ffmpeg failed").strip().splitlines()
        last_err = "\n".join(err[-8:]) if err else "ffmpeg audio failed"
    raise RuntimeError(last_err)


def s3_download_prefix(s3, bucket: str, prefix: str, dest: Path) -> None:
    paginator = s3.get_paginator("list_objects_v2")
    count = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            key = obj["Key"]
            if key.endswith("/"):
                continue
            rel = key[len(prefix):].lstrip("/")
            if not rel or rel == "ready":
                continue
            path = dest / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            log(f"download s3://{bucket}/{key}")
            s3.download_file(bucket, key, str(path))
            count += 1
    log(f"downloaded {count} objects")


def s3_delete_prefix(s3, bucket: str, prefix: str) -> None:
    paginator = s3.get_paginator("list_objects_v2")
    batch = []
    deleted = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents") or []:
            batch.append({"Key": obj["Key"]})
            if len(batch) == 1000:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
                deleted += len(batch)
                batch = []
    if batch:
        s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
        deleted += len(batch)
    log(f"deleted {deleted} ingest objects under {prefix}")


def job_name_key(item: dict) -> str:
    name = str(item.get("filename") or item.get("disc") or "").strip().lower()
    return re.sub(r"\.(mp4|m4v|mov|mpeg|mpg|avi|mkv|wmv|mp3|aiff|aif|wav|flac|m4a)$", "", name) or name


def job_record_id(item: dict) -> str:
    return str(item.get("jobId") or str(item.get("pk") or "").replace("JOB#", ""))


def job_record_time(item: dict) -> str:
    return str(item.get("createdAt") or item.get("updatedAt") or "")


def jobs_to_supersede(items: list[dict]) -> list[dict]:
    rows = list(items or [])
    active_names = {
        job_name_key(item)
        for item in rows
        if str(item.get("status") or "") in ("UPLOADING", "QUEUED", "CONVERTING")
    }
    active_names.discard("")
    keep: dict[str, dict] = {}
    for item in rows:
        key = job_name_key(item)
        if not key or key in active_names or str(item.get("status") or "") != "READY":
            continue
        prev = keep.get(key)
        newer = (
            not prev
            or job_record_time(item) > job_record_time(prev)
            or (job_record_time(item) == job_record_time(prev) and job_record_id(item) > job_record_id(prev))
        )
        if newer:
            keep[key] = item
    out = []
    for item in rows:
        key = job_name_key(item)
        keeper = keep.get(key)
        if not key or not keeper or key in active_names:
            continue
        if job_record_id(item) == job_record_id(keeper):
            continue
        if str(item.get("status") or "") in ("UPLOADING", "QUEUED", "CONVERTING"):
            continue
        out.append(item)
    return out


def list_user_jobs(table, user_id: str) -> list[dict]:
    if not user_id:
        return []
    from boto3.dynamodb.conditions import Key
    items = []
    kwargs = {
        "IndexName": "userId-createdAt-index",
        "KeyConditionExpression": Key("userId").eq(user_id),
    }
    while True:
        resp = table.query(**kwargs)
        items.extend(resp.get("Items") or [])
        last = resp.get("LastEvaluatedKey")
        if not last:
            break
        kwargs["ExclusiveStartKey"] = last
    return items


def supersede_replaced_jobs(s3, table, ingest_bucket: str, user_id: str) -> None:
    if not user_id:
        return
    for item in jobs_to_supersede(list_user_jobs(table, user_id)):
        pk = item.get("pk") or f"JOB#{job_record_id(item)}"
        ingest = str(item.get("ingestKey") or "")
        if ingest.startswith(f"incoming/{user_id}/"):
            if not ingest.endswith("/"):
                ingest += "/"
            s3_delete_prefix(s3, ingest_bucket, ingest)
        table.delete_item(Key={"pk": pk, "sk": item.get("sk") or "META"})
        log("superseded job", pk)


def job_pk(disc: str) -> str:
    return os.environ.get("JOB_PK") or f"JOB#{disc}"


def put_job(table, disc: str, **fields) -> None:
    pk = job_pk(disc)
    existing = {}
    try:
        got = table.get_item(Key={"pk": pk, "sk": "META"})
        existing = got.get("Item") or {}
    except Exception as err:
        log("could not read job", err)
    item = dict(existing)
    item.update({
        "pk": pk,
        "sk": "META",
        "disc": disc,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    if not item.get("createdAt"):
        item["createdAt"] = item["updatedAt"]
    user_id = os.environ.get("USER_ID") or item.get("userId") or ""
    source = os.environ.get("SOURCE") or item.get("source") or ""
    filename = os.environ.get("FILENAME") or item.get("filename") or ""
    if user_id:
        item["userId"] = user_id
    if source:
        item["source"] = source
    if filename:
        item["filename"] = filename
    item.update(fields)
    if not item.get("error"):
        item.pop("error", None)
    table.put_item(Item=item)


CONVERSION_LOG_ROOT = "conversion-log/"


def conversion_log_key(user_id: str, job_id: str) -> str:
    owner = slug_filename(user_id) if str(user_id or "").strip() else "cli"
    jid = slug_filename(job_id) or "unknown"
    return f"{CONVERSION_LOG_ROOT}{owner}/{jid}.json"


def conversion_record(
    *,
    job_id: str,
    user_id: str = "",
    filename: str = "",
    disc: str = "",
    kind: str = "",
    status: str = "",
    output_keys: list | None = None,
    output_prefix: str = "",
    ingest_key: str = "",
    source: str = "",
    error: str = "",
    created_at: str = "",
    updated_at: str = "",
) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "jobId": job_id,
        "userId": user_id or "",
        "filename": filename or "",
        "disc": disc or "",
        "kind": kind or "",
        "status": status or "",
        "outputKeys": [str(key) for key in (output_keys or []) if key],
        "outputPrefix": output_prefix or "",
        "ingestKey": ingest_key or "",
        "source": source or "",
        "error": error or "",
        "createdAt": created_at or now,
        "updatedAt": updated_at or now,
    }


def persist_conversion_log(s3, bucket: str, record: dict) -> str:
    job_id = str(record.get("jobId") or "unknown")
    key = conversion_log_key(str(record.get("userId") or ""), job_id)
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(record, indent=2, default=str).encode("utf-8"),
        ContentType="application/json",
    )
    log("conversion log", f"s3://{bucket}/{key}")
    return key


def persist_conversion_log_from_job(s3, table, ingest_bucket: str, disc: str, kind: str = "") -> str | None:
    if not ingest_bucket:
        return None
    pk = job_pk(disc)
    item = {}
    try:
        item = (table.get_item(Key={"pk": pk, "sk": "META"}).get("Item") or {})
    except Exception as err:
        log("could not read job for conversion log", err)
    job_id = str(item.get("jobId") or pk.replace("JOB#", "", 1) or disc)
    record = conversion_record(
        job_id=job_id,
        user_id=str(item.get("userId") or os.environ.get("USER_ID") or ""),
        filename=str(item.get("filename") or os.environ.get("FILENAME") or ""),
        disc=str(item.get("disc") or disc),
        kind=str(item.get("kind") or kind or os.environ.get("EDIT_KIND") or ""),
        status=str(item.get("status") or ""),
        output_keys=item.get("outputKeys") or [],
        output_prefix=str(item.get("outputPrefix") or ""),
        ingest_key=str(item.get("ingestKey") or ""),
        source=str(item.get("source") or os.environ.get("SOURCE") or ""),
        error=str(item.get("error") or ""),
        created_at=str(item.get("createdAt") or ""),
        updated_at=str(item.get("updatedAt") or ""),
    )
    return persist_conversion_log(s3, ingest_bucket, record)


_FFMPEG_TIME_RE = re.compile(r"^(?:\d+(?:\.\d+)?|\d+:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?)$")
_NORMALIZE_VIDEO = (
    "scale=1280:720:force_original_aspect_ratio=decrease,"
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
)


def safe_ffmpeg_time(value: str) -> str:
    text = str(value or "").strip()
    if not _FFMPEG_TIME_RE.match(text):
        raise RuntimeError("invalid clip time")
    return text


def safe_source_key(user_id: str, key: str) -> str:
    text = str(key or "").replace("\\", "/")
    prefix = f"users/{user_id}/Videos/"
    parts = text.split("/")
    if not user_id or not text.startswith(prefix) or any(part in ("", ".", "..") for part in parts):
        raise RuntimeError("invalid source")
    if not text.lower().endswith((".mp4", ".m4v")):
        raise RuntimeError("invalid source")
    return text


def safe_output_name(raw: str) -> str:
    name = slug_filename(Path(str(raw or "edit.mp4")).name)
    if not name.lower().endswith(".mp4"):
        name += ".mp4"
    return name


def s3_download_keys(s3, bucket: str, keys: list[str], dest: Path) -> list[Path]:
    paths = []
    for index, key in enumerate(keys):
        path = dest / f"{index:02d}-{slug_filename(Path(key).name)}"
        path.parent.mkdir(parents=True, exist_ok=True)
        log(f"download s3://{bucket}/{key}")
        s3.download_file(bucket, key, str(path))
        paths.append(path)
    return paths


def concat_list_line(path: Path) -> str:
    return "file '" + str(path).replace("'", "'\\''") + "'"


def write_concat_list(paths: list[Path], dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    list_path = dest / "concat.txt"
    list_path.write_text("".join(concat_list_line(path) + "\n" for path in paths))
    return list_path


def ffmpeg_clip_commands(src: Path, output: Path, start: str, end: str) -> list[list[str]]:
    start_at = safe_ffmpeg_time(start)
    end_at = safe_ffmpeg_time(end)
    shared = ["ffmpeg", "-y", "-hide_banner", "-ss", start_at, "-to", end_at, "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?"]
    copy = [*shared, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", str(output)]
    encode = [
        *shared,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output),
    ]
    return [copy, encode]


def ffmpeg_normalize_command(src: Path, output: Path, has_audio: bool) -> list[str]:
    if has_audio:
        filt = f"[0:v:0]{_NORMALIZE_VIDEO}[v];[0:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]"
        return [
            "ffmpeg", "-y", "-hide_banner", "-i", str(src),
            "-filter_complex", filt,
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            str(output),
        ]
    return [
        "ffmpeg", "-y", "-hide_banner", "-i", str(src),
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-filter_complex", f"[0:v:0]{_NORMALIZE_VIDEO}[v]",
        "-map", "[v]", "-map", "1:a:0",
        "-shortest",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output),
    ]


def ffmpeg_combine_commands(list_file: Path, output: Path) -> list[list[str]]:
    copy = [
        "ffmpeg", "-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", "-movflags", "+faststart", str(output),
    ]
    encode = [
        "ffmpeg", "-y", "-hide_banner", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(output),
    ]
    return [copy, encode]


def run_ffmpeg_attempts(commands: list[list[str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    last_err = "ffmpeg failed"
    for cmd in commands:
        log("ffmpeg", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0 and output.exists() and output.stat().st_size > 0:
            return
        err = (proc.stderr or proc.stdout or "ffmpeg failed").strip().splitlines()
        last_err = "\n".join(err[-8:]) if err else "ffmpeg failed"
        if output.exists():
            output.unlink()
    raise RuntimeError(last_err)


def media_has_audio(path: Path) -> bool:
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0", str(path),
        ],
        capture_output=True,
        text=True,
    )
    return bool((proc.stdout or "").strip())


def run_ffmpeg_clip(src: Path, output: Path, start: str, end: str) -> None:
    run_ffmpeg_attempts(ffmpeg_clip_commands(src, output, start, end), output)


def run_ffmpeg_combine(inputs: list[Path], output: Path) -> None:
    work = output.parent
    try:
        run_ffmpeg_attempts(ffmpeg_combine_commands(write_concat_list(inputs, work), output), output)
        return
    except RuntimeError as err:
        log("concat failed, normalizing", err)
        if output.exists():
            output.unlink()
    normalized = []
    norm_dir = work / "normalized"
    for index, src in enumerate(inputs):
        dest = norm_dir / f"{index:02d}.mp4"
        run_ffmpeg_attempts([ffmpeg_normalize_command(src, dest, media_has_audio(src))], dest)
        normalized.append(dest)
    run_ffmpeg_attempts(ffmpeg_combine_commands(write_concat_list(normalized, norm_dir), output), output)


def prepare_edit(s3, output_bucket: str, work: Path, out_dir: Path, kind: str) -> list[tuple[Path, str, str]]:
    user_id = os.environ.get("USER_ID") or ""
    keys = [safe_source_key(user_id, key) for key in json.loads(os.environ.get("SOURCE_KEYS") or "[]")]
    if kind == "clip" and len(keys) != 1:
        raise RuntimeError("clip needs one video")
    if kind == "combine" and len(keys) < 2:
        raise RuntimeError("combine needs at least two videos")
    sources = s3_download_keys(s3, output_bucket, keys, work)
    filename = safe_output_name(os.environ.get("FILENAME") or "edit.mp4")
    dest = out_dir / filename
    if kind == "clip":
        run_ffmpeg_clip(sources[0], dest, os.environ.get("CLIP_START") or "", os.environ.get("CLIP_END") or "")
    else:
        run_ffmpeg_combine(sources, dest)
    return [(dest, filename, "video/mp4")]


def main() -> int:
    import boto3

    disc = slug_filename(os.environ.get("DISC_NAME") or "")
    prefix = os.environ.get("INCOMING_PREFIX") or f"incoming/{disc}/"
    if not prefix.endswith("/"):
        prefix += "/"
    ingest_bucket = os.environ["INGEST_BUCKET"]
    output_bucket = os.environ["OUTPUT_BUCKET"]
    output_prefix = os.environ.get("OUTPUT_PREFIX") or "Videos/"
    if not output_prefix.endswith("/"):
        output_prefix += "/"
    table_name = os.environ["JOBS_TABLE"]

    s3 = boto3.client("s3")
    table = boto3.resource("dynamodb").Table(table_name)
    work = Path(tempfile.mkdtemp(prefix="disc-"))
    out_dir = Path(tempfile.mkdtemp(prefix="mp4-"))
    output_keys = []
    record_kind = ""
    try:
        put_job(table, disc, status="CONVERTING", ingestKey=prefix, outputPrefix=output_prefix)
        edit_kind = str(os.environ.get("EDIT_KIND") or "").strip().lower()
        produced: list[tuple[Path, str, str]] = []
        if edit_kind in ("clip", "combine"):
            record_kind = edit_kind
            produced = prepare_edit(s3, output_bucket, work, out_dir, edit_kind)
        else:
            s3_download_prefix(s3, ingest_bucket, prefix, work)
            plan = detect_jobs(work, disc)
            record_kind = str(plan.get("kind") or "")
            log("detect", json.dumps({
                "kind": plan.get("kind"),
                "outputs": [o.get("name") for o in plan.get("outputs") or []],
                "reason": plan.get("reason"),
            }))
            if plan.get("kind") == "none":
                raise RuntimeError(plan.get("reason") or "No video or audio found")
            if plan.get("kind") == "audio":
                music_root = music_root_of(output_prefix)
                existing = list_music_album_names(s3, output_bucket, music_root)
                for item in list_user_jobs(table, os.environ.get("USER_ID") or ""):
                    existing.append(str(item.get("outputPrefix") or ""))
                    existing.extend(str(key) for key in (item.get("outputKeys") or []))
                output_prefix = audio_output_prefix(output_prefix, existing)
                put_job(table, disc, status="CONVERTING", ingestKey=prefix, outputPrefix=output_prefix)
            for job in plan["outputs"]:
                dest = out_dir / job["name"]
                is_audio = bool(job.get("audio")) or dest.suffix.lower() == ".mp3"
                if is_audio:
                    run_ffmpeg_audio(job["inputs"], dest)
                    content_type = "audio/mpeg"
                else:
                    run_ffmpeg(job["inputs"], dest, job["concat"])
                    content_type = "video/mp4"
                produced.append((dest, job["name"], content_type))
        for dest, name, content_type in produced:
            key = f"{output_prefix}{name}"
            log(f"upload s3://{output_bucket}/{key}")
            s3.upload_file(
                str(dest),
                output_bucket,
                key,
                ExtraArgs={"ContentType": content_type},
            )
            output_keys.append(key)
        put_job(
            table, disc,
            status="READY",
            kind=record_kind,
            ingestKey=prefix,
            outputPrefix=output_prefix,
            outputKeys=output_keys,
            error="",
        )
        try:
            persist_conversion_log_from_job(s3, table, ingest_bucket, disc, record_kind)
        except Exception as log_err:
            log("could not write conversion log", log_err)
        s3_delete_prefix(s3, ingest_bucket, prefix)
        supersede_replaced_jobs(s3, table, ingest_bucket, os.environ.get("USER_ID") or "")
        log("done", output_keys)
        return 0
    except Exception as err:
        message = str(err)
        log("FAILED", message)
        try:
            put_job(
                table, disc,
                status="FAILED",
                kind=record_kind,
                ingestKey=prefix,
                outputPrefix=output_prefix,
                outputKeys=output_keys,
                error=message[:1000],
            )
        except Exception as put_err:
            log("could not write FAILED status", put_err)
        try:
            persist_conversion_log_from_job(s3, table, ingest_bucket, disc, record_kind)
        except Exception as log_err:
            log("could not write conversion log", log_err)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
