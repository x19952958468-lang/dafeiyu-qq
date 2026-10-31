# 第三方组件与授权

本仓库原创的 Node / Python 集成代码和文档采用根目录 [MIT License](LICENSE)。这不等于所有外部程序、模型权重、参考声音、音乐或生成内容均采用 MIT。

## 仓库内的例外

| 路径 | 来源与许可 |
| --- | --- |
| `integrations/singing/patches/seed-vc-mac.patch` | 基于 Seed-VC `inference.py` 的 float32 兼容修改，按 GPL-3.0 提供；见同目录 [LICENSE.GPL-3.0](integrations/singing/patches/LICENSE.GPL-3.0) |

该补丁的对应完整上游源码位于 [Seed-VC 固定提交 `51383efd921027683c89e5348211d93ff12ac2a8`](https://github.com/Plachtaa/seed-vc/tree/51383efd921027683c89e5348211d93ff12ac2a8)，变更和应用方式见 [唱歌安装说明](integrations/singing/README.md)。补丁中的上游上下文不改用 MIT。

## 当前参考录音

`presets/current/references/` 中的三段参考录音由仓库所有者确认已获得公开再分发授权，来源和校验值见 [预设说明](presets/current/README.md)。这些第三方来源录音不适用 MIT 代码许可证；本仓库不据此授予额外的商业、声音身份或原歌曲使用权。

## 外部安装的程序

这些程序的完整源码、二进制和安装环境不随本仓库分发。下载后应保留各自的许可与声明。

| 组件 | 用途 | 上游 |
| --- | --- | --- |
| NapCatQQ | QQ / OneBot 协议连接 | [NapCatQQ](https://github.com/NapNeko/NapCatQQ) |
| Seed-VC | 歌声换声，代码 GPL-3.0 | [固定版本与许可](https://github.com/Plachtaa/seed-vc/blob/51383efd921027683c89e5348211d93ff12ac2a8/LICENSE) |
| Demucs | 人声 / 伴奏分离 | [facebookresearch/demucs](https://github.com/facebookresearch/demucs) |
| Breeze MLX 服务 | 情绪语音，代码 Apache-2.0 | [Shoofio 固定版本与许可](https://github.com/Shoofio/breeze-tts2-fast-streaming-api/blob/f1818ec44da33302701718e5fb15267ce1cf5e4f/LICENSE) |
| FFmpeg | 音频编码、混音及视频抽帧 | [FFmpeg 许可说明](https://ffmpeg.org/legal.html)，具体取决于编译选项 |
| MLX VLM | Apple Silicon 本地视觉推理 | [Blaizzy/mlx-vlm](https://github.com/Blaizzy/mlx-vlm) |
| Faster Whisper | 本地语音转写 | [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |

Python 依赖的具体版本列在各集成目录中。安装时会引入更多传递依赖，应以其发行包中的 LICENSE / NOTICE 为准。此表是主要组件索引，不是把所有依赖重新授权的声明。

## 模型与输出

**Breeze 代码许可与模型许可不同。** Breeze 官方将代码列为 Apache-2.0，但模型权重、检查点、适配器、派生模型和自托管输出适用独立的研究及非商业许可。公开本仓库或使用 MIT 集成代码不会授予这些模型及本地输出的商业权利。参见 [官方许可说明](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/README.md#license-and-responsible-use) 和 [模型许可全文](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE)。

使用的量化模型也保留原模型约束：

- [mlx-community/Breeze-TTS-2-mlx-8bit](https://huggingface.co/mlx-community/Breeze-TTS-2-mlx-8bit)
- [Shoof/Gust-MLX](https://huggingface.co/Shoof/Gust-MLX)
- [mlx-community/Qwen2.5-VL-3B-Instruct-4bit](https://huggingface.co/mlx-community/Qwen2.5-VL-3B-Instruct-4bit)
- [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)

模型下载器固定了版本，具体 revision 见各集成说明。Seed-VC、Demucs 运行时取得的模型也应分别核对授权。仓库没有附带这些权重。

## 声音、音乐与平台账号

参考音频、声音身份、歌曲音源和生成媒体的使用权由其相应权利与许可决定，不由本仓库代码许可授予。QQ、B站与模型服务的账号仍适用对应服务条款。公开仓库没有包含部署者的账号凭据、登录态或私人角色正文。获准分发的参考录音单独注明来源与授权范围。
