# pt-backend — podcast-together 自建后端

用 Node.js 原生实现的 podcast-together 后端，与原项目的 laf 云函数协议**完全一致**（客户端无感知），不需要 laf、不需要数据库。

- `POST /room-operate` — CREATE / ENTER / HEARTBEAT / LEAVE
- `POST /parse-text` — 解析小宇宙 / Apple Podcast 中国区 / pod.link / 微信公众号音频 / https 直链
- `POST /pt-service` — 健康检查
- `WebSocket`（同端口）— CONNECTED / FIRST_SEND / SET_PLAYER / HEARTBEAT / NEW_STATUS

房间状态保存在内存并落盘到 `data/rooms.json`（重启不丢），内置原 `room-clock` 的巡检逻辑（每 15s 清理掉线成员、暂停无人房间），房间 7 天未自动标记过期。

## 本地运行

```bash
npm install
npm start          # 默认 3000 端口，可用 PORT=xxx 改
```

验证协议是否正确：

```bash
node test/protocol-test.mjs   # 需先启动服务，16 项断言全过即协议一致
```

## 部署到公网(正式联调/上架需要)

任选其一，要求 Node >= 18：

| 方式 | 说明 |
|------|------|
| 自己的 VPS | `npm install && PORT=3000 npm start`，前面挂 Nginx 做 TLS(`Upgrade` 头要透传给 WebSocket) |
| Zeabur / Railway / Render / Fly.io | 直接识别 `package.json`，`npm start` 即可；注意选有中国访问质量线路的平台 |
| Sealos 云开发 | 兼容 laf 生态，也可以跑这个 Node 服务 |

**必须 HTTPS/WSS**：微信小程序正式环境只允许 `https` 请求和 `wss` 连接，`http://`/`ws://` 只能在开发工具和「不校验域名」的真机调试里用。

Nginx 参考配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket 必需
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## 与官方协议的差异

- roomId 由 laf 的 24 位文档 id 改为 6 位大写字母数字(客户端不感知，反而更好念)
- Visitor 统计只存内存(不影响功能)
- 原来的定时触发器 room-clock 变成进程内置的 setInterval
