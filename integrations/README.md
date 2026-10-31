# 可选本地推理组件

主机器人通过文件队列或本机 HTTP 调用这些组件。它们分别使用独立的 Python 环境，避免 PyTorch、Transformers 和 MLX 版本冲突。此目录包含适配代码、参数示例和下载方法；模型、虚拟环境、登录态与生成内容不随仓库发布。仓库另提供 [三段获准分发的当前参考声音](../presets/current/README.md)。

- [唱歌](singing/README.md)：搜索可播放歌曲，分离人声，Seed-VC 换音色，再混合伴奏；保留 D 参数和约 20 秒选段。
- [情绪语音](breeze/README.md)：Breeze TTS 2 的 Apple Silicon MLX 后端。
- [B站视频理解](bilibili-video/README.md)：本地抽帧描述与语音转写。

这些适配源于 Apple Silicon Mac 部署。Node 主程序、Python 工作器与模型环境的可移植程度不同；未验证 Windows 完整安装，唱歌工作器目前使用 POSIX 文件锁，语音及视觉默认使用 MLX。模型推理耗时、音色相似度和情绪表现需要在目标机器上验收。安装文档中的模型命令会下载数 GB 文件，只有主动执行命令时才开始下载。

`work/`、`data/` 和各组件的本地配置均应保留在 Git 之外。路径示例均从仓库根目录执行。请分别阅读各上游代码及模型许可；本仓库的代码许可不会替代模型、音源或参考声音的授权。

`DAFEIYU_WORK_DIR` 可统一改变默认模型和环境根目录；建议设为绝对路径，并在 Node、模型下载和手动运行命令中使用相同的值。
