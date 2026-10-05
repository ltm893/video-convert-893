import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import convert


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

    def test_concat_list_escapes_quotes(self):
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            listed = convert.write_concat_list([Path("/tmp/it's.mp4")], folder)
            self.assertIn("file '/tmp/it'\\''s.mp4'", listed.read_text())
            copy, encode = convert.ffmpeg_combine_commands(listed, folder / "out.mp4")
            self.assertEqual(copy[copy.index("-f") + 1], "concat")
            self.assertIn("libx264", encode)

    def test_queued_edit_is_not_superseded(self):
        gone = convert.jobs_to_supersede([
            {"jobId": "clip", "filename": "Race-highlight.mp4", "status": "QUEUED", "createdAt": "2026-10-05T14:00:00Z"},
            {"jobId": "old", "filename": "Race-highlight", "status": "READY", "createdAt": "2026-10-01T10:00:00Z"},
        ])
        self.assertEqual(gone, [])


if __name__ == "__main__":
    unittest.main()
