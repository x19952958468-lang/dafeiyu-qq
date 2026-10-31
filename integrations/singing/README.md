# 可选唱歌工作器

每次请求先匹配歌曲标题并获取公开可播放音源，使用 Demucs 分离人声，再通过独立 Seed-VC 进程换成参考音色，混合原伴奏并编码为 MP3。不是通用作曲模型，无法保证所有歌曲都可获取。公开搜索/播放接口可能变化；无法取得音源时返回失败。使用你有权使用的音源和参考声音。

D 参数只保留一套：50 步、歌声升 12 半音、CFG 0.7、人声高通 70 Hz/低通 8000 Hz、响度 -18 LUFS。可以使用自己的参考声音，也可以导入 [已获准分发的当前参考人声](../../presets/current/README.md)。`target_seconds=20` 优先取自然停顿；连续演唱缺少合适停顿时在目标附近淡出，并非每次都能唱完完整乐段。

## 安装

需要 Python 3.12、Git、FFmpeg 和足够的模型空间。以下适配在 Apple Silicon Mac 使用过；工作器依赖 `fcntl`，没有提供可直接运行的 Windows 文件锁实现。安装从仓库根目录执行：

```sh
mkdir -p work data/singing
git clone https://github.com/Plachtaa/seed-vc.git work/seed-vc
git -C work/seed-vc checkout 51383efd921027683c89e5348211d93ff12ac2a8
git -C work/seed-vc apply ../../integrations/singing/patches/seed-vc-mac.patch
python3.12 -m venv work/singing-venv
work/singing-venv/bin/python -m pip install -r integrations/singing/requirements.lock.txt
cp integrations/singing/settings.example.json integrations/singing/settings.local.json
```

`requirements.lock.txt` 记录原 Mac 环境中安装的版本，并非跨平台依赖解析保证。不要直接混装 Seed-VC 上游带 CUDA 选项的 requirements 与本锁定文件。安装报平台或版本冲突时，按目标机器和上游说明另建环境。

编辑 `settings.local.json`：

- `reference` 指向你提供的干净人声 WAV，默认 `data/singing/reference.wav`。
- `python` 指向上述虚拟环境；`ffmpeg` 默认从 PATH 找 `ffmpeg`，也可填写可执行文件路径。
- `data_root` 与 Node 的 `singing.dataDir` 使用同一目录，默认 `data/singing`。
- 所有相对文件路径均相对于**仓库根目录**，不是启动命令的当前目录。若设置 `DAFEIYU_WORK_DIR`，示例中的 `work/...` 路径改用该根目录；建议把此环境变量设为绝对路径。
- 首次推理需要下载 Seed-VC / Demucs 所需模型。示例没有启用 Hugging Face 离线模式；模型全部准备并验证后，才可在 `env` 中设置 `HF_HUB_OFFLINE=1` 和 `TRANSFORMERS_OFFLINE=1`。

先做本地试唱（不会发送 QQ 消息），把示例歌名换成你有权使用且可获取的歌曲：

```sh
work/singing-venv/bin/python integrations/singing/worker.py \
  --settings integrations/singing/settings.local.json \
  --song '歌曲名 歌手名' --output data/singing/local-check
```

确认 `result.mp3` 完整、音色和时长合适，再创建验收标记并启动文件队列工作器：

```sh
touch data/singing/engine-tested
work/singing-venv/bin/python integrations/singing/start.py
```

Node 可配置 `singing.workerLauncher` 指向上述 `start.py` 启动器；以根配置模板的字段结构为准。未提供参考音频或没有 `engine-tested` 标记时，队列工作器不会就绪。不要复制别人的验收标记来跳过本地检查。服务心跳位于 `data/singing/heartbeat.json`，日志位于 `data/singing/worker.log`。

## 验证

下面只使用合成数组和临时配置，不下载模型、不获取音乐、不发 QQ 消息：

```sh
work/singing-venv/bin/python integrations/singing/check_sections.py
work/singing-venv/bin/python integrations/singing/check_vocal_tone.py
python3 integrations/singing/check_settings.py
```

原始工程已验证这些选段和滤波算法；发布整理后的版本另做语法和离线测试。新机器仍需完成真实推理验收。

## 上游来源与许可

- [Seed-VC](https://github.com/Plachtaa/seed-vc/tree/51383efd921027683c89e5348211d93ff12ac2a8) 固定于 `51383efd921027683c89e5348211d93ff12ac2a8`，上游代码采用 [GPL-3.0](https://github.com/Plachtaa/seed-vc/blob/51383efd921027683c89e5348211d93ff12ac2a8/LICENSE)。未把上游源码或权重装入本仓库。
- `patches/seed-vc-mac.patch` 是该版本 `inference.py` 的两行 float32 兼容修改，修改时间 2026-10-23。补丁及其上游上下文按 GPL-3.0 提供，许可证在 [`patches/LICENSE.GPL-3.0`](patches/LICENSE.GPL-3.0)。完整对应上游源文件可通过上述固定提交取得，再应用补丁。
- [Demucs](https://github.com/facebookresearch/demucs) 和 Seed-VC 下载的各模型、依赖分别保留其上游许可。声音和歌曲的使用权不由本仓库授予。
