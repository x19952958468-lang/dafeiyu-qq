# 可选本地视频理解

Node 抽取公开视频片段、帧图和音频后，通过 JSON 请求文件调用 `analyze_local.py`。适配器不接收 B站 Cookie，也不发平台评论。图像文字仅作为视频内容处理，不执行其中的指令。

视觉路径使用 Apple Silicon 的 MLX VLM；转写路径使用 CPU int8 Faster Whisper。安装在单独的 Python 3.12 环境：

```sh
mkdir -p work/bilibili-video
python3.12 -m venv work/bilibili-video/venv
work/bilibili-video/venv/bin/python -m pip install -r integrations/bilibili-video/requirements-mac.txt
python3 integrations/bilibili-video/download_models.py
```

下载器默认写入 `work/bilibili-video/models/`；如设置 `DAFEIYU_WORK_DIR`，改用该根目录下的 `bilibili-video/models/`，也可通过 `--model-dir` 改目录。固定模型来源：

- `mlx-community/Qwen2.5-VL-3B-Instruct-4bit` @ `46d4cf06a06ffc1a766c214174f9cbed2f45bcab`，目录 `qwen-vl`；[模型页面](https://huggingface.co/mlx-community/Qwen2.5-VL-3B-Instruct-4bit)。
- `Systran/faster-whisper-small` @ `536b0662742c02347bc0e980a01041f333bce120`，目录 `whisper-small`；[模型页面](https://huggingface.co/Systran/faster-whisper-small)。

下载脚本检查文件大小并保留 `.part` 断点文件。模型和依赖遵循各自上游许可；本仓库不分发它们。

在主机器人的 `config.json` 中配置 `bilibili.content`，指向上述 Python、`integrations/bilibili-video/analyze_local.py`、FFmpeg 和两个模型目录。以根配置示例和 `src/bilibili/content.js` 的字段为准；这些模型路径不在管理界面中编辑。该版本未做 Windows 视觉路径适配。

适配器 CLI：

```sh
work/bilibili-video/venv/bin/python integrations/bilibili-video/analyze_local.py \
  --request data/bilibili/local-request.json --output data/bilibili/local-result.json
```

请求结构为 `{ "mode": "vision", "model": "本地模型目录", "frames": ["本地图像路径"] }`，或 `{ "mode": "asr", "model": "本地模型目录", "audio": "本地音频路径" }`。视觉最多 6 帧；描述不覆盖帧间全部剧情；自动转写可能漏听或误识别。首次使用前在目标电脑上做实际素材验证。
