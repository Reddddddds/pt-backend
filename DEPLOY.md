# 部署到腾讯云(国内网络 100% 可用方案)

分两个阶段,**阶段一不需要备案,当天就能用**;阶段二等备案下来后再做。

## 阶段一:国内服务器 + IP 直连(当天可用)

### 1. 买服务器(约 ¥60~120/年)

1. 打开 `https://cloud.tencent.com/product/lighthouse`(轻量应用服务器);
2. 新用户选「**2核2G**」入门款,地域选离朋友最近的(如广州/上海/南京);
3. 镜像选 **Ubuntu Server 24.04 LTS**;
4. 付款后进入控制台,记下服务器的**公网 IP**;
5. 控制台 → 防火墙 页签,放行端口:**22**(默认已开)、**3000**。

### 2. 部署后端(SSH 上去,复制粘贴即可)

在你电脑的终端里(把 `服务器IP` 换成你的公网 IP,首次要输你买服务器时设置的密码):

```bash
# 上传代码(Windows 自带 scp;目录是 D:\work\DDlisten\pt-backend)
scp -r /d/work/DDlisten/pt-backend root@服务器IP:/opt/pt-backend
```

SSH 登录服务器(`ssh root@服务器IP`),然后:

```bash
# 装 Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 装 pm2 守护进程
npm install -g pm2

# 启动(把 my-secret-2024 换成你自己的口令!)
cd /opt/pt-backend
npm install
PT_TOKEN=my-secret-2024 pm2 start src/server.js --name pt-backend
pm2 save && pm2 startup    # 开机自启
```

验证:你电脑浏览器打开 `http://服务器IP:3000/pt-service`,返回 `{"code":"0000"...}` 即成功。

### 3. 小程序切到线上

`podcast-together-miniprogram/config.js`:

```js
API_URL: "http://服务器IP:3000",
WEBSOCKET_URL: "ws://服务器IP:3000",
TOKEN: "my-secret-2024",     // 与服务器上 PT_TOKEN 一致
```

开发者工具「编译」确认正常 → 「上传」新版本 → 公众平台重新设为体验版 → 发朋友。
朋友打开后开一次「开发调试」(右上角 `···` → 开发调试),之后无论在哪个城市都能一起听。

## 阶段二:域名 + HTTPS + 合法域名(备案后,去掉调试模式)

### 1. 买域名并备案

1. 腾讯云买一个域名(`.com`/`.cn` 首年 ¥30~60);
2. 控制台搜「**ICP 备案**」,用刚买的服务器作为备案机器提交个人备案(全程线上,约 1~2 周,管局审核通过会短信通知)。

### 2. 服务器上装 Nginx + HTTPS 证书

```bash
apt-get install -y nginx certbot python3-certbot-nginx

# 反向代理配置(HTTP 先通,顺便给 certbot 用)
cat > /etc/nginx/sites-available/pt <<'EOF'
server {
    listen 80;
    server_name 你的域名;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
EOF
ln -sf /etc/nginx/sites-available/pt /etc/nginx/sites-enabled/pt
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 一条命令签发免费 HTTPS 证书并自动配置
certbot --nginx -d 你的域名
```

### 3. 配置小程序合法域名

微信公众平台 → 开发管理 → 开发设置 → 服务器域名:

- request 合法域名:`https://你的域名`
- socket 合法域名:`wss://你的域名`
- downloadFile 合法域名:`https://media.xyzcdn.net`

`config.js` 改成:

```js
API_URL: "https://你的域名",
WEBSOCKET_URL: "wss://你的域名",
TOKEN: "my-secret-2024",
```

重新上传体验版。此后朋友**不再需要开调试模式**,体验与正式小程序一致;要公开上架就提交审核。

## 常见问题

- **服务器重启后服务没了**:确认执行过 `pm2 save && pm2 startup`。
- **想看日志**:`pm2 logs pt-backend`。
- **换口令**:服务器上 `PT_TOKEN=新口令 pm2 restart pt-backend --update-env`,小程序 `config.js` 同步改并重新上传。
- **房间数据**在 `/opt/pt-backend/data/rooms.json`,重启不丢;备份就是拷这个文件。
