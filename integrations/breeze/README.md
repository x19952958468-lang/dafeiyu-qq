# 可选 Breeze 情绪语音后端（Apple Silicon）

本目录只有发布用启动器和模型下载入口。推理服务从上游固定提交安装；没有复制上游推理源码或模型。Node 主程序调用 `POST /v1/audio/speech`，读取完整 24 kHz 单声道 PCM，再转换成 QQ 可发送的音频。服务在一次重型任务占用期间前台运行，由 Node 管理进程生命周期。

## 安装

需要 Apple Silicon Mac、Python 3.12、Git，以及支持 `--overrides` 的 `uv`。与唱歌、B站模型分开建环境：

```sh
mkdir -p work
git clone https://github.com/Shoofio/breeze-tts2-fast-streaming-api.git work/breeze-tts
git -C work/breeze-tts checkout f1818ec44da33302701718e5fb15267ce1cf5e4f
python3.12 -m venv work/breeze-venv
uv pip install --python work/breeze-venv/bin/python \
  -r work/breeze-tts/requirements.txt \
  --overrides work/breeze-tts/requirements-mac-overrides.txt
work/breeze-venv/bin/python integrations/breeze/download_models.py --variant 8bit
```

需要 `mixed` 情绪配置时另下载：

```sh
work/breeze-venv/bin/python integrations/breeze/download_models.py --variant mixed
```

模型固定版本：

| 配置名 | 仓库 | Revision | 本地目录 |
| --- | --- | --- | --- |
| 8bit | `mlx-community/Breeze-TTS-2-mlx-8bit` | `c6e4a2ff6ab9afba68b7853de802273ffe23fb49` | `work/breeze-models/8bit` |
| mixed | `Shoof/Gust-MLX` | `dac391237f6bf6130b1c1d277f0ebc0b886e419e` | `work/breeze-models/mixed` |

原部署分别约 4.6 GB / 7.3 GB，安装还需依赖、缓存和推理内存空间。下载入口用 Hugging Face 客户端固定 revision，不会在导入模块或查看 `--help` 时下载模型。

从仓库根目录手动启动服务：

```sh
sh integrations/breeze/serve.sh
```

手动启动只用于本地检查；检查完按 Ctrl+C 停止，再用 `npm start` 启动主机器人。不要保留手动服务与 Node 同时管理同一个端口，主程序会拒绝接管不属于自己的现存进程。

默认监听 `127.0.0.1:6197`，不开放 WebSocket，模型加载阶段 `/health` 返回未就绪。参考 WAV 和准确转写需自行提供，写入本地 `data/speech/config.json` 的 `referenceAudio` / `referenceText`；语音管理界面用于启用、模式、比例和强度等选项。也可通过 [当前预设](../../presets/current/README.md) 导入已获准分发的演示参考片段。固定随机种子不会保证不同句子的音色完全一致；此后端的情绪、哭声及音色稳定性仍需试听调整。

`DAFEIYU_WORK_DIR` 可改变默认 `work/` 根目录（建议绝对路径），模型下载器与启动器均读取它。启动器支持更具体的环境变量：`BREEZE_SOURCE_DIR`、`BREEZE_PYTHON`、`BREEZE_MODELS_DIR`、`BREEZE_PORT`、`BREEZE_MLX_CACHE_GB`。`BREEZE_LOCAL_VARIANT` 仅接受 `8bit` 或 `mixed`。相对环境变量路径按进程当前目录解释，建议使用绝对路径。Node 的 backend 启动配置指向 `integrations/breeze/serve.sh`；正常使用时由主程序持有重型计算锁并启动服务，无需另留一个常驻实例。

## 声音与情绪配置模板

[`speech-config.example.json`](speech-config.example.json) 是参考调参起点：默认关闭语音，`autoRate=0.7`、`intensity=0.85`、`cfgScale=4`、`seed=42`。先准备你有权使用的参考 WAV 和**与音频完全对应的转写**，再复制模板（已有配置时先备份，不要覆盖）：

```sh
mkdir -p data/speech
cp -n integrations/breeze/speech-config.example.json data/speech/config.json
```

在本地文件中把 `PLACEHOLDER_ABSOLUTE_REFERENCE_WAV` 替换为真实、存在、可读的 WAV **绝对路径**；把 `REPLACE_WITH_EXACT_REFERENCE_TRANSCRIPT` 替换为该 WAV 的准确原话。需要时修改 `ffmpeg` 可执行文件路径。占位符不是有效配置，不能直接启用。完成模型安装和本地试听后，才把 `enabled` 改成 `true` 或在管理界面开启。

[`emotion-profiles.example.json`](emotion-profiles.example.json) 可选，含 `happy`、`sad`、`annoyed`、`gentle`、`playful`、`surprised` 六种配置。它们提供通用表演指令，使用 `mixed` 模型；`sad` 使用 CFG 2 和 `vocalization: "sob"`，其余使用 CFG 4。这些示例模板提供配置机制和参数；要沿用原部署的参考片段与参数，请使用 [当前预设](../../presets/current/README.md)。模型仍不保证每句听感相同。

```sh
cp -n integrations/breeze/emotion-profiles.example.json data/speech/emotion-profiles.json
```

复制后必须替换**每种情绪**中的参考路径和转写；可以先给六种情绪使用同一份你自己的参考音频。文件必须真实存在且可读，否则该情绪配置会被拒绝并回退到默认声音。若未下载 `mixed` 模型或暂不需要独立情绪参考，直接不创建 `data/speech/emotion-profiles.json`，使用默认声音及程序生成的语气指导即可。基础参考声音、情绪参考和唱歌参考是三个独立配置位置。

情绪模板里的 `instruction` 是给推理模型的表演指导，不是要读给用户的台词；正文/舞台描述的分离仍由 Node 语音规划处理。`sob` 仅用于悲伤模式下对独立哭声事件的转换。试听时使用正常短句，检查身份音色、自然度和情绪幅度后再调整，避免仅凭参数数值判断效果。

## 来源与许可

- 使用的服务：[Shoofio/breeze-tts2-fast-streaming-api](https://github.com/Shoofio/breeze-tts2-fast-streaming-api/tree/f1818ec44da33302701718e5fb15267ce1cf5e4f)，固定提交 `f1818ec44da33302701718e5fb15267ce1cf5e4f`；代码采用 [Apache-2.0](https://github.com/Shoofio/breeze-tts2-fast-streaming-api/blob/f1818ec44da33302701718e5fb15267ce1cf5e4f/LICENSE)。
- Breeze 官方明确区分代码与模型许可：权重、派生模型和本地自托管输出适用研究及非商业许可；不能因为代码采用 Apache-2.0 就宣称模型或输出可任意商用。参见 [Breeze 官方许可说明](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/README.md#license-and-responsible-use) 和模型目录自带的 LICENSE/NOTICE。
- MLX、MLX Audio、音频 tokenizer 等依赖各自保留上游许可。安装说明不授予参考声音、输入内容或声音身份的使用权。
