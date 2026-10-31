"""Download a pinned optional checkpoint; this command performs network and disk writes."""
import argparse
import os
from pathlib import Path

MODELS = {
    "8bit": ("mlx-community/Breeze-TTS-2-mlx-8bit", "c6e4a2ff6ab9afba68b7853de802273ffe23fb49"),
    "mixed": ("Shoof/Gust-MLX", "dac391237f6bf6130b1c1d277f0ebc0b886e419e"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=MODELS, default="8bit")
    parser.add_argument("--output-root", type=Path,
                        default=Path(os.environ.get("DAFEIYU_WORK_DIR", Path(__file__).resolve().parents[2] / "work")) / "breeze-models")
    args = parser.parse_args()
    from huggingface_hub import snapshot_download
    repo, revision = MODELS[args.variant]
    destination = args.output_root.expanduser().resolve() / args.variant
    snapshot_download(repo_id=repo, revision=revision, local_dir=str(destination))
    print(f"Downloaded {repo}@{revision} to {destination}")


if __name__ == "__main__":
    main()
