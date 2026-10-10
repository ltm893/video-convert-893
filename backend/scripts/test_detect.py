#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
from convert import detect_jobs, ffmpeg_error_is_css, ffmpeg_input_args, jobs_to_supersede, slug_filename, vob_title_groups

SUPERSEDE_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "jobs-to-supersede.json").read_text()
)


class DetectTests(unittest.TestCase):
    def test_slug(self):
        self.assertEqual(slug_filename("DVD Video Recording"), "DVD-Video-Recording")
        self.assertEqual(slug_filename("  "), "disc")

    def test_video_ts_one_title(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ts = root / "VIDEO_TS"
            ts.mkdir()
            (ts / "VIDEO_TS.IFO").write_bytes(b"ifo")
            (ts / "VTS_01_0.VOB").write_bytes(b"x" * 100)
            (ts / "VTS_01_1.VOB").write_bytes(b"x" * 1_500_000)
            (ts / "VTS_01_2.VOB").write_bytes(b"x" * 1_500_000)
            (ts / "VTS_01_3.VOB").write_bytes(b"x" * 200_000)
            groups = vob_title_groups(ts)
            self.assertEqual(len(groups), 1)
            self.assertEqual(len(groups[0][1]), 2)
            plan = detect_jobs(root, "DVD-Video-Recording")
            self.assertEqual(plan["kind"], "video_ts")
            self.assertEqual(plan["outputs"][0]["name"], "DVD-Video-Recording.mp4")
            self.assertTrue(plan["outputs"][0]["concat"])

    def test_video_ts_two_titles(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ts = root / "VIDEO_TS"
            ts.mkdir()
            (ts / "VTS_01_1.VOB").write_bytes(b"x" * 1_500_000)
            (ts / "VTS_02_1.VOB").write_bytes(b"x" * 1_500_000)
            plan = detect_jobs(root, "Family")
            self.assertEqual([o["name"] for o in plan["outputs"]], [
                "Family-title01.mp4",
                "Family-title02.mp4",
            ])

    def test_prefers_video_ts_over_video_rm(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            ts = root / "VIDEO_TS"
            ts.mkdir()
            (ts / "VTS_01_1.VOB").write_bytes(b"x" * 1_500_000)
            vrm = root / "VIDEO_RM"
            vrm.mkdir()
            (vrm / "VIDEO_RM.DAT").write_bytes(b"x" * 1_500_000)
            plan = detect_jobs(root, "Disc")
            self.assertEqual(plan["kind"], "video_ts")

    def test_dvd_vr_when_no_usable_vob(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "VIDEO_TS").mkdir()
            (root / "VIDEO_TS" / "VTS_01_0.VOB").write_bytes(b"menu")
            vrm = root / "VIDEO_RM"
            vrm.mkdir()
            (vrm / "VIDEO_RM.DAT").write_bytes(b"x" * 1_500_000)
            plan = detect_jobs(root, "VR")
            self.assertEqual(plan["kind"], "dvd_vr")
            self.assertEqual(plan["outputs"][0]["name"], "VR.mp4")

    def test_loose_mp4(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "holiday.mp4").write_bytes(b"x" * 1_500_000)
            plan = detect_jobs(root, "Holiday")
            self.assertEqual(plan["kind"], "files")
            self.assertEqual(plan["outputs"][0]["name"], "Holiday.mp4")

    def test_small_web_mp4(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "clip.mov").write_bytes(b"x" * 20_000)
            plan = detect_jobs(root, "clip")
            self.assertEqual(plan["kind"], "files")
            self.assertEqual(plan["outputs"][0]["name"], "clip.mp4")

    def test_css_hint(self):
        self.assertTrue(ffmpeg_error_is_css("Encrypted VOB, CSS copy protection"))
        self.assertFalse(ffmpeg_error_is_css("frame=  10 fps=10"))

    def test_concat_protocol_for_vob_parts(self):
        a = Path("/tmp/VTS_01_1.VOB")
        b = Path("/tmp/VTS_01_2.VOB")
        self.assertEqual(
            ffmpeg_input_args([a, b], True),
            ["-i", "concat:/tmp/VTS_01_1.VOB|/tmp/VTS_01_2.VOB"],
        )
        self.assertEqual(ffmpeg_input_args([a], True), ["-i", "/tmp/VTS_01_1.VOB"])

    def test_jobs_to_supersede_waits_until_ready(self):
        for row in SUPERSEDE_FIXTURE:
            gone = [item["jobId"] for item in jobs_to_supersede(row["items"])]
            self.assertEqual(gone, row["superseded"], row["name"])


if __name__ == "__main__":
    unittest.main()
