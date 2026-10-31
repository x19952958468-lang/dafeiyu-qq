"""Start the optional POSIX singing worker with a separate log and process session."""
import argparse
import json
from pathlib import Path
import subprocess
import time
from settings import load_settings


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", type=Path, default=here / "settings.local.json")
    args = parser.parse_args()
    settings_path = args.settings.resolve()
    settings = load_settings(settings_path)
    heartbeat = Path(settings["data_root"]) / "heartbeat.json"
    try:
        state = json.loads(heartbeat.read_text())
        if state.get("ready") and time.time() - state["time"] < 30:
            print("唱歌引擎已在运行。")
            return
    except (OSError, ValueError, KeyError):
        pass
    log_path = Path(settings["runtime_log"])
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("ab") as log:
        process = subprocess.Popen(
            [settings["python"], str(here / "worker.py"), "--settings", str(settings_path)],
            cwd=here, stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL, start_new_session=True,
        )
    print("正在启动唱歌引擎，PID:", process.pid)
    time.sleep(2)
    if process.poll() is not None:
        raise SystemExit(f"引擎启动失败，查看日志: {log_path}")
    print("已启动。重启电脑后需再次启动。")


if __name__ == "__main__":
    main()
