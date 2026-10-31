"""Offline checks for repository-relative configuration; no model/network imports."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from settings import REPOSITORY, load_settings


class SettingsTests(unittest.TestCase):
    def load(self, updates=None):
        value = {"data_root": "data/singing", "seed_root": "work/seed-vc",
                 "reference": "data/singing/reference.wav", "runtime_log": "data/singing/worker.log"}
        value.update(updates or {})
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings.json"
            path.write_text(json.dumps(value))
            return load_settings(path)

    def test_paths_use_repository_not_settings_or_working_directory(self):
        actual = self.load()
        self.assertEqual(actual["reference"], str(REPOSITORY / "data/singing/reference.wav"))
        self.assertEqual(actual["ffmpeg"], "ffmpeg")

    def test_executable_path_is_resolved_but_path_command_is_preserved(self):
        actual = self.load({"python": "work/singing-venv/bin/python", "ffmpeg": "ffmpeg-custom"})
        self.assertEqual(actual["python"], str(REPOSITORY / "work/singing-venv/bin/python"))
        self.assertEqual(actual["ffmpeg"], "ffmpeg-custom")

    def test_custom_work_directory_relocates_example_environment_paths(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DAFEIYU_WORK_DIR": directory}):
            actual = self.load({"python": "work/singing-venv/bin/python"})
            self.assertEqual(actual["seed_root"], str(Path(directory).resolve() / "seed-vc"))
            self.assertEqual(actual["python"], str(Path(directory).resolve() / "singing-venv/bin/python"))
            self.assertEqual(actual["data_root"], str(REPOSITORY / "data/singing"))

    def test_missing_required_paths_fail_before_launch(self):
        with self.assertRaises(ValueError):
            self.load({"reference": ""})


if __name__ == "__main__":
    unittest.main()
