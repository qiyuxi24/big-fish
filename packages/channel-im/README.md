# @bigfish/channel-im

闲鱼 IM 通道（钉钉 lwp 长连接）的纯函数与状态机：帧构造/解析、消息归一化、会话状态机。
零第三方依赖，不建连接、不发网络、不落库——ws 适配器与 token 签名分别由 daemon / channel-mtop 负责。

协议事实：`docs/im-protocol.md`。契约：`docs/component-decomposition.md`。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/frames.ts` | 常量（ws 地址、appKey、心跳/ack 间隔）、`encodeFrame`/`parseFrameText`、`buildRegFrame`/`buildHeartbeatFrame`/`buildAckFrame`/`buildAckDiffFrame`、`buildImTokenRequest`、`generateMid`/`generateDeviceId`、`readPath`/`readText`/`readInteger`/`isRecord` |
| `src/messages.ts` | `decodePushItems`（base64(JSON) → 对象，跳过系统提示）、`parseImMessage`/`parsePushMessages` 归一化出 `ImChatMessage`（cid 去 `@goofish`、发送者、文本、毫秒时间戳、redReminder → 交易状态） |
| `src/session.ts` | `ImSession` 状态机：idle → handshaking → registered（心跳循环）→ disconnected 可重连 / closed 终态；传输、时钟、回调全部注入 |

## 用法

```ts
import { ImSession, parsePushMessages, SYSTEM_CLOCK } from '@bigfish/channel-im'

const session = new ImSession({
  transport,           // { send, onMessage, close }
  clock: SYSTEM_CLOCK, // 测试注入假时钟即可推进时间，不 sleep
  onMessage: (text) => {
    for (const message of parsePushMessages(JSON.parse(text))) console.log(message.cid, message.text)
  },
})
await session.start({ token: '...' })
```

## 状态

- 已实现：帧构造/解析、消息归一化（标准聊天 + 卡片消息）、会话状态机与心跳/ack、32 个单测（假传输 + 假时钟）。
- 未接线：daemon 侧 ws 适配器、mtop 取 token、把消息投给发货规则引擎（P2 后续）。
- 已知边界：卡片更新（`msg["1"]` 是字符串）与 base64(MessagePack) 分支尚未实现，遇到直接跳过并留待 `reply` 阶段核实。
