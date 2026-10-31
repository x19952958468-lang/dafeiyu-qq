# 配置说明

## 主配置

运行 `npm run setup` 后编辑根目录的 `config.json`。配置加载器按 `config.json`、`config.local.json`、`config.example.json` 顺序查找，找到第一个存在的文件后停止；它们不会互相叠加。主程序要求先创建自己的本地配置，不会只拿示例文件接入 QQ。未填写的字段使用源码默认值。

主配置应在修改后重启 Node 进程。网页的人设编辑器、B站设置和语音设置有各自的即时更新接口，不需要靠重启保存。

| 字段 | 作用 |
| --- | --- |
| `onebot.ws` | OneBot 11 正向 WebSocket 地址；示例为本机 3001 |
| `onebot.accessToken` | 协议端的访问令牌，保持与 NapCat 一致 |
| `onebot.autoAcceptInvite` | 是否自动接受入群邀请；示例为 `false` |
| `llm.baseUrl` / `apiKey` / `model` | 兼容 `/chat/completions` 的模型接口 |
| `llm.judgeModel` | 是否接话等轻量判断使用的模型名 |
| `persona.file` / `selfName` | 人设正文路径、机器人称呼 |
| `whitelist.groups` / `friends` | 允许响应的群 / 私聊好友；使用字符串数组 |
| `mutedGroups` | 暂停发言的群号数组 |
| `trigger.ignoreUserIds` | 不回应的用户 QQ 数组 |
| `limits` | 本地预算估计、群冷却、每小时回复量、静默时段 |
| `pricing` | 每百万输入 / 输出 token 的计费估计，用于预算统计 |

`pricing` 中的数值只是示例，不代表模型服务的最新价格。按实际服务修改；本地预算是应用统计，不能代替服务商的账单或硬性消费上限。

## 回复范围与主动发言

示例白名单包含 `REPLACE_WITH_GROUP_ID` 和 `REPLACE_WITH_FRIEND_QQ`，这些占位值不会匹配真实账号。准备启用时再替换。

**白名单 `[]` 表示不限制。** 若只启用私聊，保留群占位值并关闭群触发；若只启用群聊，保留好友占位值并关闭私聊触发。不要用空数组表达“禁止全部”。

| 字段 | 作用 |
| --- | --- |
| `trigger.alwaysReplyMention` | 群内 @ 机器人时回复 |
| `trigger.alwaysReplyPrivate` | 私聊消息回复 |
| `trigger.alwaysReplyToReply` | 对方引用机器人消息时继续回复 |
| `trigger.keywordWake` | 唤醒关键词数组 |
| `trigger.interjectRate` | 非直接对话时的插话概率，`0` 关闭 |
| `trigger.interjectRampSec` | 随等待时间增加插话概率；`0` 关闭 |
| `proactiveAt.groups` | 定时主动 @ 的群列表；空数组关闭 |
| `trigger.focusUsers` | 重点回应 / 主动联系的对象配置；示例为空 |

跨群发消息只接受绑定主人的私聊指令，目标群必须明确在群白名单中且没有静默。主人绑定来自 B站后台的接收 QQ 设置。仅在你确实希望该账号能发往目标群时配置这些选项。

## 人设

`persona/example.md` 是公开的中性模板，`persona/dafeiyu.md` 是本地实际正文，已加入 `.gitignore`。

打开后台的人设编辑页，修改后点击保存。编辑器检查版本、备份旧正文，并在保存成功后更新当前进程的人设；旧备份位于 `data/persona/backups/`。直接修改磁盘正文时重启 Node 进程加载。

角色口吻和事实记录不同：B站评论、推荐和唱歌任务结果由模块提供，模型应先回答实际做了什么，再使用人设语气。不应仅靠提示词宣称已经执行操作。

## B站

后台默认监听 `127.0.0.1:6196`。主配置可设置 `bilibili.uiPort` 改端口。

后台保存的兴趣词、每日评论量、推荐量、浏览间隔及接收 QQ 位于 `data/bilibili/config.json`。首次使用需要：

1. 将接收 QQ 加入机器人的好友，并加入主配置的私聊白名单。
2. 在后台选择该 QQ 并保存。
3. 用自己的 B站账号扫码确认。
4. 完成内容理解后端的配置；检查本地试运行结果，再开启活动。

“每天最多评论”设 `0` 表示不评论。活动记录保存在 `data/bilibili/state.json`，聊天里询问“刚才评论了什么”会使用记录回答。登录过期、风控或证据不足时，状态页会显示相应结果，不保证每个视频都能评论或推荐。

## 语音

本地配置位于 `data/speech/config.json`，与主配置分开。网页主要调整 `enabled`、`mode`、`autoRate`、`intensity`、`maxChars`；后端地址和参考音频需按 [可选后端说明](../integrations/README.md) 准备。

已部署 Breeze 后端后，可在 Node 停止时创建本地配置：

```sh
mkdir -p data/speech
cp integrations/breeze/speech-config.example.json data/speech/config.json
```

已有配置时不要覆盖。填写 `referenceAudio` 的绝对文件路径及 `referenceText` 的准确转写；需要自定义 FFmpeg 时填写 `ffmpeg`。启动 Node 后，在后台开启语音并用中性短句试听。此示例保持 `enabled: false`，不会在没有参考声音时自动开始合成。

`mode` 可用 `auto`（按比例语音）、`voice`（优先语音）或 `text`（文字）。语音失败、超时或台词分离不可靠时会回退文字，不把生成失败的片段当作成功发送。

情绪参考配置位于 `data/speech/emotion-profiles.json`，可选情绪为 `happy`、`sad`、`annoyed`、`gentle`、`playful`、`surprised`。模板为 [emotion-profiles.example.json](../integrations/breeze/emotion-profiles.example.json)。通用模板需自行填写；[当前预设](../presets/current/README.md) 另附获准分发的参考片段及对应转写，权重仍需单独下载。参考音频路径应是本机可读的绝对路径；替换模板中的占位项后再使用。

## 路径与环境变量

以下变量从进程环境读取，不会自动加载 `.env` 文件。需要时在启动前设置，或由自己的进程管理器注入。

| 环境变量 | 默认值 / 作用 |
| --- | --- |
| `DAFEIYU_WORK_DIR` | 仓库内 `work/`；存放外部运行环境和模型 |
| `DAFEIYU_FFMPEG` | `ffmpeg`，从 PATH 查找；可设为可执行文件绝对路径 |
| `DAFEIYU_BILI_PYTHON` | `work/bilibili-video/venv/bin/python`；Windows 使用 `Scripts/python.exe` |
| `DAFEIYU_SPEECH_LAUNCHER` | 仓库内 `integrations/breeze/serve.sh` |
| `DAFEIYU_PYTHON` | `python3`；启动唱歌 launcher 使用的解释器 |
| `DAFEIYU_DEBUG` | 设置后输出更多本地调试信息；日志可能包含聊天信息 |

主配置还可用 `bilibili.content` 传入 `contentPython`、`contentWorker`、`visionModel`、`asrModel` 和 `ffmpeg`，覆盖视频理解的默认路径。`bilibili.qrPython` 可单独指定二维码编码使用的 Python。

环境变量与自定义目录必须同后端安装位置一致。模型下载与可选后端不会因为 Node 启动而自动安装。
