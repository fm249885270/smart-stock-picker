# 智能选股上线说明

目标：把工具部署为 `stock.fengmu.me`，再从 `fengmu.me` 首页增加入口。

## 服务器要求

- Linux 服务器（已有 Nginx）
- Node.js 20 或更高版本
- 服务器可访问同花顺、东方财富等行情接口
- 已把 `stock.fengmu.me` 解析到服务器公网 IP

## 首次部署

1. 把整个项目目录上传到服务器，例如 `/root/muge-tool`。
2. 在服务器执行：`sudo bash /root/muge-tool/deploy/install.sh`
3. 确认 DNS：`stock.fengmu.me` 的 A 记录指向服务器 IP。
4. 申请 HTTPS 证书，例如：`sudo certbot --nginx -d stock.fengmu.me`
5. 打开 `https://stock.fengmu.me/` 检查行情与 K 线。

## 首页入口

把 `deploy/首页入口卡片.html` 的内容插入 `fengmu.me` 首页 `<div class="main">` 内，
位置建议放在第一个内容区块之前。样式沿用网站现有卡片，不会破坏原布局。

## 日常维护

- 查看状态：`systemctl status muge-tool`
- 查看日志：`journalctl -u muge-tool -f`
- 重启服务：`systemctl restart muge-tool`
- 用户数据保存在 `/var/lib/muge-tool/state.json`

## 可选：只允许自己访问

在 Nginx 配置中取消 Basic Auth 三行注释，并执行：

`sudo htpasswd -c /etc/nginx/.muge-tool.htpasswd 你的用户名`

然后执行 `sudo systemctl reload nginx`。手机访问时会要求输入用户名和密码。

## 说明

这个工具是实时服务，不是纯静态网页；不能只把 `public` 目录上传到原网站。
必须让 Node 服务常驻，并由 Nginx 反向代理到 `127.0.0.1:8787`。