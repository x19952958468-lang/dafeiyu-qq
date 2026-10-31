"""Native macOS singing worker, with complete vocal-section selection."""
import argparse
import fcntl
import html
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import numpy as np
import soundfile as sf

from phrase_segments import complete_section, mix_section
from vocal_tone import smooth_vocal
from settings import load_settings

LOG = logging.getLogger("singing")
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}


class SongUnavailable(Exception):
    pass


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def api(path, params):
    url = "https://api.bilibili.com" + path + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as response:
        result = json.load(response)
    if result.get("code") != 0:
        raise SongUnavailable("音源平台暂时没有返回可用结果，请稍后再试。")
    return result.get("data") or {}


def find_song(song):
    result = api("/x/web-interface/search/type", {
        "search_type": "video", "keyword": song + " 歌曲 原唱", "page_size": 10,
    })
    requested = [re.sub(r"[\W_]", "", part).casefold() for part in song.split()]
    for item in result.get("result", []):
        title = html.unescape(re.sub(r"<[^>]*>", "", item.get("title", "")))
        normalized = re.sub(r"[\W_]", "", title).casefold()
        # Do not silently sing an unrelated top search result.
        if not requested or not all(part and part in normalized for part in requested):
            continue
        bvid = item.get("bvid", "")
        if re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
            yield bvid, title


def download_song(bvid, destination):
    info = api("/x/web-interface/view", {"bvid": bvid})
    duration = info.get("duration", 0)
    if not 20 <= duration <= 1200:
        raise SongUnavailable("找到的音源长度不合适，试试加上歌手名。")
    play = api("/x/player/playurl", {"bvid": bvid, "cid": info["cid"], "fnval": 16})
    audios = play.get("dash", {}).get("audio") or []
    if not audios:
        raise SongUnavailable("这首歌目前获取不到可用音源，试试加上歌手名。")
    stream = max(audios, key=lambda item: item.get("bandwidth", 0))
    url = stream.get("baseUrl") or stream.get("base_url")
    if not url:
        raise SongUnavailable("这首歌的音源链接不可用。")
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=40) as response, destination.open("wb") as output:
        total = 0
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            total += len(chunk)
            if total > 40 * 1024 * 1024:
                raise SongUnavailable("这首歌的音源过大，试试指定其他版本。")
            output.write(chunk)
    return {"bvid": bvid, "title": info["title"], "duration": duration,
            "url": "https://www.bilibili.com/video/" + bvid + "/"}


def fetch_music(song, destination):
    """Use only publicly playable audio; unavailable tracks are skipped."""
    headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com/"}
    search = "https://music.163.com/api/search/get/web?" + urllib.parse.urlencode(
        {"s": song, "type": 1, "limit": 10})
    with urllib.request.urlopen(urllib.request.Request(search, headers=headers), timeout=20) as response:
        data = json.load(response)
    requested = [re.sub(r"[\W_]", "", part).casefold() for part in song.split()]
    attempted = 0
    for track in data.get("result", {}).get("songs", []):
        name = track.get("name", "")
        artists = " ".join(a.get("name", "") for a in track.get("artists", []))
        title = name + " " + artists
        normalized = re.sub(r"[\W_]", "", title).casefold()
        if not all(part and part in normalized for part in requested):
            continue
        if any(word in name for word in ("纯音乐", "钢琴版", "伴奏", "铃声")):
            continue
        duration = track.get("duration", 0) / 1000
        if not 20 <= duration <= 1200:
            continue
        attempted += 1
        url = "https://music.163.com/song/media/outer/url?" + urllib.parse.urlencode({"id": str(track["id"]) + ".mp3"})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
                content_type = response.headers.get("Content-Type", "")
                if not (content_type.startswith("audio/") or "octet-stream" in content_type):
                    continue
                with destination.open("wb") as output:
                    total = 0
                    while chunk := response.read(1024 * 256):
                        total += len(chunk)
                        if total > 40 * 1024 * 1024:
                            raise SongUnavailable("音源文件过大")
                        output.write(chunk)
            return {"provider": "netease", "id": track["id"], "title": title,
                    "duration": duration, "url": "https://music.163.com/#/song?id=" + str(track["id"])}
        except (OSError, ValueError, SongUnavailable):
            LOG.info("Public audio unavailable for candidate %s", track["id"])
        if attempted >= 3:
            break
    return None


def run(command, cwd, env, log, timeout=600):
    with log.open("ab") as output:
        subprocess.run(command, cwd=cwd, env=env, stdout=output,
                       stderr=subprocess.STDOUT, check=True, timeout=timeout)


def separate(source, directory, seed_root, env, duration=0):
    run([sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs",
         "--shifts", "0", "-d", "cpu", "-j", "2", "--segment", "7",
         "-o", str(directory / "separated"), str(source)],
        seed_root, env, directory / "engine.log", timeout=max(600, duration*4+120))
    folder = directory / "separated" / "htdemucs" / source.stem
    return folder / "vocals.wav", folder / "no_vocals.wav"


def generate(song, folder, settings, env, target_seconds=None):
    seed_root = Path(settings["seed_root"])
    reference = Path(settings["reference"])
    if not reference.is_file():
        raise SongUnavailable("还没有准备好她的音色，暂时不能唱歌。")
    attempts = []
    selected = None
    try:
        selected = fetch_music(song, folder / "source.m4a")
    except (SongUnavailable, OSError, ValueError):
        LOG.info("Music search unavailable, trying secondary provider")
    if selected is None:
        try:
            for bvid, title in find_song(song):
                try:
                    selected = download_song(bvid, folder / "source.m4a")
                    break
                except (SongUnavailable, OSError, ValueError) as error:
                    attempts.append(str(error))
                if len(attempts) >= 3:
                    break
        except (SongUnavailable, OSError, ValueError):
            LOG.info("Secondary public search unavailable")
    if selected is None:
        raise SongUnavailable("这首歌暂时找不到可用音源，试试“歌名 歌手名”或换一首。")
    write_json(folder / "source.json", selected)
    ffmpeg = settings["ffmpeg"]
    excerpt = folder / "excerpt.wav"
    # Decode the full track: a short analysis window can itself cut a lyric line.
    run([ffmpeg, "-y", "-i", str(folder / "source.m4a"),
         "-ar", "44100", "-ac", "2", str(excerpt)],
        seed_root, env, folder / "engine.log", timeout=max(60, selected["duration"]))
    vocals_path, backing_path = separate(excerpt, folder, seed_root, env, selected["duration"])
    vocals, sr = sf.read(vocals_path, dtype="float32", always_2d=True)
    try:
        target_seconds = float(settings.get('target_seconds', 20) if target_seconds is None else target_seconds)
        section = complete_section(vocals, sr, target_seconds=target_seconds)
    except ValueError as error:
        raise SongUnavailable(str(error)) from error
    section_seconds = (section.end-section.start)/sr
    LOG.info("Selected complete section %.2f-%.2fs, %s phrases", section.start/sr, section.end/sr, section.phrase_count)
    dry = folder / "vocal_input.wav"
    sf.write(dry, vocals[section.start:section.end].mean(axis=1), sr)
    output = folder / "converted"
    try:
        run([sys.executable, str(seed_root / "inference.py"), "--source", str(dry),
             "--target", str(reference), "--output", str(output), "--f0-condition", "True",
             "--auto-f0-adjust", "False", "--semi-tone-shift", str(settings.get("pitch_shift", 0)),
             "--diffusion-steps", str(settings.get("steps", 30)),
             "--inference-cfg-rate", str(settings.get("inference_cfg_rate", 0.7)), "--fp16", "False"],
            seed_root, env, folder / "engine.log", timeout=float(settings.get('inference_timeout_sec', 300)))
    except subprocess.TimeoutExpired as error:
        raise SongUnavailable('这次换音色超时了，暂未生成成功，请稍后重试。') from error
    files = list(output.glob("*.wav"))
    if len(files) != 1:
        raise RuntimeError("模型没有产生唯一的翻唱音频")
    converted, sample_rate = sf.read(files[0], dtype="float32", always_2d=True)
    backing, backing_sr = sf.read(backing_path, dtype="float32", always_2d=True)
    if sample_rate != sr or backing_sr != sr:
        raise RuntimeError("模型与伴奏采样率不一致")
    converted = smooth_vocal(converted[:, 0], sr,
                             settings.get('vocal_highpass_hz', 0),
                             settings.get('vocal_lowpass_hz', 0))
    mix = mix_section(converted, backing[section.start:section.end], sr, section)
    temporary = folder / "result.tmp.wav"
    sf.write(temporary, mix, sr, subtype="PCM_24")
    os.replace(temporary, folder / "result.wav")
    # Compressed delivery removes the old four-megabyte/short-WAV restriction.
    loudness_args = []
    if settings.get('output_lufs') is not None:
        loudness_args = ['-af', f"loudnorm=I={float(settings['output_lufs'])}:TP=-1.5:LRA=11"]
    run([ffmpeg, "-y", "-i", str(folder / "result.wav"), *loudness_args, "-ac", "1", "-ar", "24000",
         "-c:a", "libmp3lame", "-b:a", "96k", str(folder / "result.tmp.mp3")],
        seed_root, env, folder / "engine.log", timeout=max(60, section_seconds))
    os.replace(folder / "result.tmp.mp3", folder / "result.mp3")
    write_json(folder / "provenance.json", {
        "requested_song": song, "source": selected,
        "source_start_seconds": section.start/sr,
        "source_end_seconds": section.end/sr,
        "last_vocal_end_seconds": section.vocal_end/sr,
        "next_vocal_start_seconds": section.next_vocal_start/sr if section.next_vocal_start is not None else None,
        "phrase_count": section.phrase_count,
        "target_seconds": target_seconds,
        "boundary_kind": section.boundary_kind,
        "duration": len(mix)/sr, "selection": "target_vocal_excerpt",
        "engine": "Seed-VC 44.1kHz SVC",
        "reference": reference.name, "steps": settings.get("steps", 30),
        "pitch_shift": settings.get("pitch_shift", 0),
        "inference_cfg_rate": settings.get("inference_cfg_rate", 0.7),
        "vocal_highpass_hz": settings.get("vocal_highpass_hz", 0),
        "vocal_lowpass_hz": settings.get("vocal_lowpass_hz", 0),
        "output_lufs": settings.get("output_lufs"),
        "generated_at": time.time(),
    })
    return folder / "result.wav"


def heartbeat(root, stop, ready):
    while not stop.is_set():
        write_json(root / "heartbeat.json", {"time": time.time(), "ready": ready, "pid": os.getpid()})
        stop.wait(5)


def job_order(folder):
    try:
        return json.loads((folder / "request.json").read_text()).get("created_at", folder.stat().st_mtime)
    except (OSError, ValueError):
        return folder.stat().st_mtime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", required=True, type=Path)
    parser.add_argument("--song", help="Generate locally once; never sends any QQ message")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    settings = load_settings(args.settings)
    LOG.info('Voice settings: steps=%s pitch=%s cfg=%s highpass=%s lowpass=%s output_lufs=%s',
             settings.get('steps', 30), settings.get('pitch_shift', 0),
             settings.get('inference_cfg_rate', 0.7), settings.get('vocal_highpass_hz', 0),
             settings.get('vocal_lowpass_hz', 0), settings.get('output_lufs'))
    root = Path(settings["data_root"])
    jobs = root / "jobs"
    jobs.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update(settings.get("env", {}))
    env["PATH"] = str(Path(settings["ffmpeg"]).parent) + os.pathsep + env.get("PATH", "")
    if args.song:
        folder = args.output.resolve() if args.output else jobs / ("local-" + str(int(time.time())))
        folder.mkdir(parents=True, exist_ok=True)
        if (folder / "result.wav").exists():
            raise RuntimeError("输出目录已有成品，请使用新目录，避免覆盖")
        print(generate(args.song, folder, settings, env), flush=True)
        return
    lock = (root / "worker.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not Path(settings["reference"]).is_file() or not (root / "engine-tested").is_file():
        raise RuntimeError("音色和端到端试唱尚未验证，不能启动群聊引擎")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    thread = threading.Thread(target=heartbeat, args=(root, stop, True), daemon=True)
    thread.start()
    try:
        while not stop.is_set():
            for folder in sorted(jobs.iterdir(), key=job_order):
                request_file = folder / "request.json"
                if not request_file.is_file() or (folder / "status.json").exists() or (folder / "finished").exists():
                    continue
                try:
                    request = json.loads(request_file.read_text())
                    song = request["song"]
                    if not isinstance(song, str) or not 1 <= len(song) <= 100:
                        raise ValueError("Invalid song")
                    if request.get("deadline", 0) < time.time():
                        write_json(folder / "status.json", {"state": "error", "message": "点歌请求已过期。"})
                        continue
                    started = time.monotonic()
                    LOG.info("Generating a new singing request in %s", folder.name)
                    generate(song, folder, settings, env, target_seconds=request.get('target_seconds'))
                    write_json(folder / "status.json", {"state": "done", "seconds": time.monotonic()-started})
                except SongUnavailable as error:
                    write_json(folder / "status.json", {"state": "error", "message": str(error)})
                except Exception:
                    LOG.exception("Generation failed in %s", folder.name)
                    write_json(folder / "status.json", {"state": "error", "message": "这次生成失败了，换一首试试。"})
            # Retain results briefly so the QQ adapter can finish reading them.
            for folder in jobs.iterdir():
                if folder.is_dir() and folder.stat().st_mtime < time.time() - 86400:
                    shutil.rmtree(folder)
            stop.wait(0.5)
    finally:
        stop.set()
        thread.join(timeout=6)
        write_json(root / "heartbeat.json", {"time": time.time(), "ready": False})


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    main()
