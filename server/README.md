# 异步图片任务后台

该服务解决“上游已经生图并扣费，但浏览器长连接中断后收不到图片”的问题。

网页只向本服务提交一次任务。本服务立即返回任务 ID，随后在服务器后台调用
`vip.aittco.com`，把成功图片保存 24 小时。网页断网、刷新或重新打开后，可以继续查询同一任务。

## 运行要求

- Node.js 14.17.6 或更高版本
- 首次部署需要在 `server` 目录执行 `npm install --production`，安装已经锁定的 Node 14 兼容依赖
- HTTPS 网站；不要直接将 3366 端口暴露到公网
- Nginx 将 `/api/image-tasks/` 反向代理到 `127.0.0.1:3366`

```bash
cd server
npm install --production
npm test
npm start
```

项目已避免使用 Node 18/20 才提供的全局 `fetch`、`FormData`、`Blob`、
`Request` 以及 `Readable.toWeb()`，可以直接在 Node.js 14.17.6 中运行。
依赖版本已固定，不要直接升级到要求更高 Node.js 版本的新版依赖。

可用环境变量：

- `PORT=3366`
- `HOST=127.0.0.1`
- `FRONTEND_ORIGIN=https://xym.aittco.com`
- `UPSTREAM_IMAGE_BASE=https://vip.aittco.com/v1`
- `UPSTREAM_IMAGE_MODEL=gpt-image-2`（正式版本默认值）

如需单独测试 2.5 模型，可在测试服务中设置
`UPSTREAM_IMAGE_MODEL=gpt-image-2.5-sunburst`；不要修改正式服务的默认值。
- `IMAGE_TASK_DATA_DIR=/var/lib/chaoqing-image-tasks`
- `TASK_RETENTION_MS=86400000`
- `MAX_ACTIVE_PER_IP=4`
- `MAX_ACTIVE_TOTAL=12`
- `MAX_UPLOAD_BYTES=67108864`

Nginx 示例：

```nginx
location /api/image-tasks/ {
    proxy_pass http://127.0.0.1:3366;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 30s;
    proxy_send_timeout 900s;
    proxy_read_timeout 900s;
    client_max_body_size 64m;
}
```

生产环境建议使用 systemd 或进程管理器保持服务运行，并把数据目录放在持久磁盘。
客户密钥只存在于当前任务的服务器内存中，不会写入任务文件或日志。


管理员模式：服务端通过密钥的 SHA-256 指纹校验管理员身份，设置页验证通过后显示三个模型选择。普通密钥无法通过构造请求切换管理员模型。可用环境变量 `ADMIN_API_KEY_SHA256` 替换默认管理员指纹，变量仅填写 64 位十六进制摘要，不填写原始密钥。管理员选择作用于新生图、参考图生成和线稿提取；图片修改仍固定使用专用模型。部署时需要同时更新前后端并重启服务。

管理员模型价格仅通过管理员验证接口返回，普通用户不会收到该价格表。前两项显示 0.3 和 0.8；第三项默认显示 0.3，可用 `ADMIN_SUNBURST_PRICE` 调整展示价格。展示价格不改变上游实际扣费。
