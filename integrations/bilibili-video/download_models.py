"""Download pinned public model files, resuming partial files after interruption."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path(os.environ.get("DAFEIYU_WORK_DIR", Path(__file__).resolve().parents[2] / "work")) / "bilibili-video"
MODELS = [
    ('mlx-community/Qwen2.5-VL-3B-Instruct-4bit', '46d4cf06a06ffc1a766c214174f9cbed2f45bcab', 'qwen-vl'),
    ('Systran/faster-whisper-small', '536b0662742c02347bc0e980a01041f333bce120', 'whisper-small'),
]


def download(task):
    repo, sha, destination, filename, expected_size = task
    output = destination / filename
    temporary = output.with_name(output.name + '.part')
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file() and output.stat().st_size == expected_size:
        return filename
    url = f'https://huggingface.co/{repo}/resolve/{sha}/{filename}'
    for attempt in range(5):
        start = temporary.stat().st_size if temporary.exists() else 0
        if start == expected_size:
            temporary.replace(output)
            return filename
        try:
            request = urllib.request.Request(url, headers={'Range': f'bytes={start}-'} if start else {})
            with urllib.request.urlopen(request, timeout=120) as response:
                if start and response.status != 206:
                    start = 0
                with temporary.open('ab' if start else 'wb') as writer:
                    count = start
                    while block := response.read(1024 * 1024):
                        count += len(block)
                        if count > expected_size:
                            raise RuntimeError('File exceeds declared repository size')
                        writer.write(block)
            if temporary.stat().st_size != expected_size:
                raise RuntimeError('Incomplete model file')
            temporary.replace(output)
            print(f'complete {destination.name}/{filename}: {expected_size} bytes', flush=True)
            return filename
        except Exception as error:
            print(f'retry {destination.name}/{filename}: {type(error).__name__}', flush=True)
            if attempt == 4:
                raise
            time.sleep(3 * (attempt + 1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=ROOT / "models")
    args = parser.parse_args()
    args.model_dir = args.model_dir.expanduser().resolve()
    args.model_dir.mkdir(parents=True, exist_ok=True)
    tasks = []
    manifest = []
    for repo, sha, local_name in MODELS:
        request = urllib.request.Request(f'https://huggingface.co/api/models/{repo}/revision/{sha}?blobs=true')
        with urllib.request.urlopen(request, timeout=60) as response:
            metadata = json.load(response)
        files = [item for item in metadata['siblings'] if item['rfilename'].endswith(('.json', '.txt', '.safetensors', '.bin'))]
        assert sum(item['size'] for item in files) < 3 * 1024**3
        destination = args.model_dir / local_name
        tasks += [(repo, sha, destination, item['rfilename'], item['size']) for item in files]
        manifest.append({'repository': repo, 'revision': sha, 'local_path': str(destination), 'files': files})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, tasks))
    (args.model_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print('All pinned models downloaded.', flush=True)


if __name__ == '__main__':
    main()
