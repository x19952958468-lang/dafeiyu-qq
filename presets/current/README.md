# 当前音色与参数预设

这里保存当前部署的三段参考声音、准确转写、六种情绪参数和 D 版唱歌参数。它们与占位配置模板不同，可以通过导入命令转换为新电脑上的实际路径。模型、账号登录态和 API Key 仍需自行配置。

## 在另一台 Mac 导入

从仓库根目录执行；已有机器人正在运行时，先在它的终端按 Ctrl+C 停止：

```sh
npm run setup
npm run preset:current
```

导入工具会校验参考录音的 SHA-256，把录音复制到 `data/references/current/`，写入本机语音及唱歌配置；覆盖的旧文件先备份到 `data/preset-backups/`。账号、模型接口、群号和发言开关不由此预设替换。导入后语音保持关闭，完成 [模型安装](../../integrations/README.md) 和试听后在管理后台开启。唱歌同样需要安装 Seed-VC、完成本地试唱并开启唱歌功能。

当前情绪配置使用 `mixed` 权重，基础声音使用 `8bit` 权重；两套都要按 [Breeze 安装说明](../../integrations/breeze/README.md) 下载。参数和参考一致也不能保证每句生成的音色完全一致。

## 私下迁移自己的人设

本目录不包含部署者的原始人设正文。已有的人设可以通过自己的设备之间传输：把该文件放到 `presets/current/persona.local.md` 后再次执行 `npm run preset:current`，或指定文件：

```sh
npm run preset:current -- --persona /absolute/path/to/persona.md
```

没有提供人设时，导入工具保留本机现有人设。提供时按原始字节复制并备份旧文件，不改写正文。`persona.local.md` 已被 Git 忽略，不会随普通提交进入公开仓库。

## 文件与来源

| 文件 | 用途 | 长度 | 来源 |
| --- | --- | --- | --- |
| `references/speech.wav` | 日常语音及多数情绪 | 3.00 秒 | [用户指定的抖音演示](https://v.douyin.com/lc4-1AWcVMY/)，15.8–18.8 秒 |
| `references/sad.wav` | 悲伤 / 哽咽参考 | 1.56 秒 | 同一演示，8.42–9.98 秒 |
| `references/singing.wav` | D 版唱歌参考 | 10.00 秒 | [《朋友的酒》邦多利版](https://www.bilibili.com/video/BV1hXbN6VEKV/)分离人声，来源说明使用 Synthesizer V 夢ノ結唱 HALO |

`references.json` 记录文件尺寸、时长、来源和 SHA-256。`speech.json`、`emotion-profiles.json` 与 `singing.json` 保存现用参数；其中参考路径由导入工具转换，不要直接把相对参考文件名作为线上绝对路径配置。

仓库所有者于 2026-10-31 明确确认已获得这三段录音公开再分发的授权。录音及声音身份不适用本仓库的 MIT 代码许可证；其后续使用范围以相应权利人授权为准。本仓库不据此授予额外的商业、声音身份或原歌曲权利。来源链接仅保留公开页面，不包含带签名的下载地址。
