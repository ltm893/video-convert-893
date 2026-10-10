import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import convert

SUPERSEDE_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "jobs-to-supersede.json").read_text()
)


def superseded_ids(name):
    row = next(item for item in SUPERSEDE_FIXTURE if item["name"] == name)
    gone = convert.jobs_to_supersede(row["items"])
    return [item["jobId"] for item in gone], row["superseded"]


class DetectJobsTest(unittest.TestCase):
    def test_audio_folder_becomes_numbered_mp3s(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "10 Audio Track.aiff").write_bytes(b"x" * 20_000)
            (root / "2 Audio Track.aiff").write_bytes(b"x" * 20_000)
            (root / "1 Audio Track.aiff").write_bytes(b"x" * 20_000)
            plan = convert.detect_jobs(root, "TomHeldAudio")
            self.assertEqual(plan["kind"], "audio")
            self.assertEqual(
                [row["name"] for row in plan["outputs"]],
                ["1-Audio-Track.mp3", "2-Audio-Track.mp3", "10-Audio-Track.mp3"],
            )
            self.assertTrue(all(row.get("audio") for row in plan["outputs"]))

    def test_video_ts_still_wins_over_audio(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ts = root / "VIDEO_TS"
            ts.mkdir()
            (ts / "VTS_01_1.VOB").write_bytes(b"x" * 1_000_001)
            (root / "song.wav").write_bytes(b"x" * 20_000)
            plan = convert.detect_jobs(root, "Family")
            self.assertEqual(plan["kind"], "video_ts")
            self.assertEqual(plan["outputs"][0]["name"], "Family.mp4")

    def test_audio_jobs_land_in_dated_cd_folder(self):
        now = datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(
            convert.audio_output_prefix("users/abc/Videos/", [], now),
            "users/abc/Music/CD20261001-1/",
        )
        self.assertEqual(
            convert.audio_output_prefix("users/abc/Music/", ["CD20261001-1"], now),
            "users/abc/Music/CD20261001-2/",
        )
        self.assertEqual(
            convert.audio_output_prefix("users/abc/Music/CD20261001-1/", [], now),
            "users/abc/Music/CD20261001-1/",
        )
        self.assertEqual(convert.music_root_of("users/abc/Music/CD20261001-1/"), "users/abc/Music/")


class EditCommandTest(unittest.TestCase):
    def test_clip_times_and_source_keys_stay_inside_mine_videos(self):
        user = "11111111-2222-3333-4444-555555555555"
        key = f"users/{user}/Videos/Race.mp4"
        self.assertEqual(convert.safe_source_key(user, key), key)
        self.assertEqual(convert.safe_ffmpeg_time("0:01:30.5"), "0:01:30.5")
        with self.assertRaises(RuntimeError):
            convert.safe_source_key(user, f"users/{user}/Photos/Race.mp4")
        with self.assertRaises(RuntimeError):
            convert.safe_ffmpeg_time("1:30; rm")
        src = Path("/tmp/in.mp4")
        out = Path("/tmp/out.mp4")
        copy, encode = convert.ffmpeg_clip_commands(src, out, "0:01:00", "0:02:00")
        self.assertEqual(copy[copy.index("-ss") + 1], "0:01:00")
        self.assertEqual(copy[copy.index("-to") + 1], "0:02:00")
        self.assertIn("libx264", encode)
        silent = convert.ffmpeg_normalize_command(src, out, False)
        self.assertIn("anullsrc=channel_layout=stereo:sample_rate=48000", silent)
        loud = convert.ffmpeg_normalize_command(src, out, True)
        self.assertNotIn("anullsrc=channel_layout=stereo:sample_rate=48000", loud)

    def test_audio_commands_copy_mp3_and_encode_other(self):
        out = Path("/tmp/out.mp3")
        mp3 = convert.ffmpeg_audio_commands(Path("/tmp/01 Song.mp3"), out)
        self.assertEqual(mp3[0][mp3[0].index("-c:a") + 1], "copy")
        wav = convert.ffmpeg_audio_commands(Path("/tmp/01 Audio Track.wav"), out)[0]
        aiff = convert.ffmpeg_audio_commands(Path("/tmp/02 Audio Track.aiff"), out)[0]
        self.assertEqual(wav[wav.index("-c:a") + 1], "libmp3lame")
        self.assertEqual(wav[wav.index("-b:a") + 1], "192k")
        self.assertIn("title=01 Audio Track", wav)
        self.assertEqual(aiff[aiff.index("-c:a") + 1], "libmp3lame")
        self.assertEqual(aiff[aiff.index("-b:a") + 1], "192k")
        self.assertIn("title=02 Audio Track", aiff)

    def test_formatted_api_clip_times_pass_ffmpeg_check(self):
        # formatMediaTimestamp output. This is the string the API stores and Fargate receives.
        for text in ("0:01:30", "0:01:30.5", "1:02:15"):
            self.assertEqual(convert.safe_ffmpeg_time(text), text)
        # Raw "1:30.5" is rejected here; the API formats it to "0:01:30.5" first.
        # Raw "24:00:01" matches this regex; the API rejects it and never stores it.
        with self.assertRaises(RuntimeError):
            convert.safe_ffmpeg_time("1:30.5")
        self.assertEqual(convert.safe_ffmpeg_time("24:00:01"), "24:00:01")

    def test_concat_list_escapes_quotes(self):
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            listed = convert.write_concat_list([Path("/tmp/it's.mp4")], folder)
            self.assertIn("file '/tmp/it'\\''s.mp4'", listed.read_text())
            copy, encode = convert.ffmpeg_combine_commands(listed, folder / "out.mp4")
            self.assertEqual(copy[copy.index("-f") + 1], "concat")
            self.assertIn("libx264", encode)

    def test_queued_edit_is_not_superseded(self):
        gone, expected = superseded_ids("queuedEdit")
        self.assertEqual(gone, expected)

    def test_reconvert_supersedes_only_the_older_same_name_job(self):
        gone, expected = superseded_ids("reconvert")
        self.assertEqual(gone, expected)

    def test_same_timestamp_keeps_the_greater_job_id(self):
        gone, expected = superseded_ids("sameTimestamp")
        self.assertEqual(gone, expected)


class ConversionLogTest(unittest.TestCase):
    def test_log_key_is_outside_incoming_and_keeps_job_id(self):
        user = "e4c834b8-b001-707d-f7ac-a9f1c25c415e"
        key = convert.conversion_log_key(user, "9b4034b0-ac8d-40cb-b6d9-04e53376f2b6")
        self.assertEqual(key, f"conversion-log/{user}/9b4034b0-ac8d-40cb-b6d9-04e53376f2b6.json")
        self.assertFalse(key.startswith("incoming/"))
        self.assertEqual(convert.conversion_log_key("", "CampingDragRacing"), "conversion-log/cli/CampingDragRacing.json")

    def test_record_lists_output_mp4s(self):
        rec = convert.conversion_record(
            job_id="abc",
            user_id="u1",
            filename="Wenner02",
            kind="video_ts",
            status="READY",
            output_keys=["users/u1/Videos/FlorenceAt4509.mp4"],
        )
        self.assertEqual(rec["filename"], "Wenner02")
        self.assertEqual(rec["outputKeys"], ["users/u1/Videos/FlorenceAt4509.mp4"])
        self.assertEqual(rec["status"], "READY")


if __name__ == "__main__":
    unittest.main()
