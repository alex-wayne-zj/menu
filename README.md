# 食记

自己和朋友使用的手机优先家庭菜单。每人维护自己的菜谱，彼此可看、可复制，修改互不干扰。选菜后按日期保存饮食记录及配料文字快照；随机推荐优先补齐一荤一素。

访问：<https://zhangjian.dev/menu/>。前端 React + TypeScript + Vite；后端 Rust + Axum；SQLite；Nginx + systemd。全部菜谱、图片和历史需登录。

## 目录

- `frontend/`：页面与随机推荐逻辑。
- `backend/`：API、数据库初始化及资源受限的图片处理。
- `assets/examples/`：六张 AI 示例图，生成提示词见 `PROMPTS.md`；960 px，约 138–173 KiB。
- `frontend/public/icons/`：暖红底、单个浅色行书“食”字的主屏图标，无边框或下划线；iPhone 使用 180 px PNG，manifest 入口限定 `/menu/`。已添加旧书签时如图标未更新，删除后重新添加。
- `deploy/`：本项目 Nginx 与 systemd 配置。
- `scripts/initialize.py`：一次性账户和示例初始化，重复运行不覆盖已有密码或菜谱。
- `scripts/deploy.py`：串行构建、备份、部署、健康检查与回滚。
- `tests/backend_integration.py`：隔离临时数据库验证 API。

## 首次部署

需要 Node.js、npm、Rust、Python 3 + venv、Nginx 和现有 HTTPS 域名。锁文件已提交；前端安装用 `npm ci`，Rust 使用 `--locked`。小 VPS 构建串行，Rust `-j 1`。

```sh
cd /root/projects/menu/backend
/root/.cargo/bin/cargo build --release --locked -j 1
cd ../frontend
npm ci
npm run build
cd ..
python3 scripts/initialize.py
python3 scripts/deploy.py --skip-build
```

初始化创建管理员和绑定指定用户名的单次邀请。首次创建默认用户名为 `admin`、`friend`，可通过 `MENU_ADMIN_USERNAME`、`MENU_FRIEND_USERNAME` 环境变量指定；已有安装继续使用私有配置中的真实账户，不重建或改名。初始密码及邀请码只写入 `/etc/menu/bootstrap-credentials.json`（root 权限 600），不写入日志或仓库。管理员首次登录后通过账户面板修改密码，之后该文件中的初始密码失效。不要将此文件通过 GitHub 或通知发送。朋友通过站主分享的专属邀请码注册。

## 账户、配置与启动

运行配置在 `/etc/menu/config.json`（root:menu，640），服务环境在 `/etc/menu/menu.env`。数据库为 `/var/lib/menu/menu.sqlite`，图片为 `/var/lib/menu/images/`；生产进程使用专属 `menu` 用户和本机 `127.0.0.1:8079`。

外置配置示例（示例值不能当真实密码）：

```json
{
  "database": "/var/lib/menu/menu.sqlite",
  "images": "/var/lib/menu/images",
  "origin": "https://zhangjian.dev",
  "bind": "127.0.0.1:8079",
  "image_python": "/opt/menu/venv/bin/python",
  "image_processor": "/opt/menu/current/image_process.py",
  "invitations": [{"username": "friend", "code": "REPLACE_WITH_RANDOM_SECRET"}]
}
```

邀请添加到 `invitations`，绑定指定用户名。邀请码在注册及管理员查看时重新读取配置，无需改代码或重启；注册后不能再次使用。管理员可在账户面板查看邀请是否已使用和重置朋友密码，用户可修改自己的密码。修改/重置密码会撤销该用户已有会话，需重新登录。不要直接编辑 SQLite 密码列。

```sh
systemctl status menu
systemctl restart menu
journalctl -u menu --since '10 minutes ago'
curl -fsS http://127.0.0.1:8079/api/health
```

Nginx 只在现有 `zhangjian.dev`、`www.zhangjian.dev` 的 HTTPS 配置中增加项目 snippet；www 的 `/menu` 重定向至主域名。更改配置必须先 `nginx -t` 再 reload。实际脚本按这台 VPS 的既有配置安装，其他服务器需调整站点 include 位置。

## 更新、备份与回滚

```sh
cd /root/projects/menu
python3 scripts/deploy.py
python3 scripts/deploy.py --backup
python3 scripts/deploy.py --rollback
```

常规部署停止本项目写入后，一致性备份 SQLite 与图片，保存到 `/var/lib/menu/backups/`；最多保留五份。随后原子切换 `/opt/menu/current` 与前端链接，启动服务、验证健康再 reload Nginx。运行产物最多保留三个最近版本及仍被链接引用的版本。

失败时恢复本次触及的 Nginx、systemd 配置和前一产物。手动 `--rollback` 只切换兼容的代码产物，保留当前数据；未来涉及不兼容迁移时须制定独立迁移与数据恢复方案，不可盲目回滚。初始版本只有建表操作，没有既有数据迁移。

需恢复数据时先停 `menu`，将选定备份解压到隔离目录确认，再替换数据库及图片；保留原数据另存备份，删除旧 WAL/SHM 前确认没有进程使用数据库；校正 `menu:menu` 所有权后启动并验证。不在运行中直接覆盖 SQLite 文件。

## 资源与安全边界

上传支持实际 JPEG/PNG/WebP，原始文件最多 10 MiB，图片最多 8 百万像素，服务端处理至最长边 960 px。压图单并发、子进程内存及时间受限；图片字段验证上传归属，复制菜品允许安全共享文件，24 小时后清理无菜谱引用的上传文件。历史保留文字快照，失效图片显示占位。

会话 Cookie 使用 HttpOnly、Secure、SameSite，写请求验证 Origin；接口服务端检查所有者和版本。Nginx 设置登录、API 限流、连接数、上传体积和超时；后端限内存 256 MiB。日志沿用 VPS 的 journald 和 Nginx 既有轮转，不记录密码或邀请码。

当前域名直接连接现有 Nginx，没有配置 CDN 清洗。上述措施降低应用滥用，不能防御打满公网带宽的 DDoS；接入防护代理需要域名账户与源站限制配合，不能影响同 VPS 的其他服务。

## 验证

```sh
cd frontend
npm test
npm run build
cd ../backend
/root/.cargo/bin/cargo test --release --locked -j 1
/root/.cargo/bin/cargo clippy --locked -- -D warnings
```

API 集成测试使用临时配置、临时数据库与独立端口，不向线上写入。测试运行参数见测试文件；覆盖注册、邀请复用、CSRF、权限、复制、版本冲突、日期冲突、历史快照、未来统计、上传格式与会话撤销。浏览器验收结果与部署状态见 `VALIDATION.md`。

```sh
cd /root/projects/menu
python3 -m venv .venv
.venv/bin/pip install Pillow==11.3.0
python3 tests/backend_integration.py
# Real HTTPS UI check creates temporary uniquely named test content and cleans it up.
MENU_E2E_URL=https://zhangjian.dev/menu/ MENU_TEST_CREDENTIALS=/etc/menu/bootstrap-credentials.json node tests/browser_smoke.mjs
```

公开仓库仅包含源码、锁文件、部署模板、测试和 AI 示例图。实际账户、密码、邀请码、用户上传图片、数据库、备份、日志、测试截图及包含真实账户标识的内部需求/设计文档留在 VPS，不提交。

手机布局回归：`node tests/ui_layout.mjs` 使用临时本机静态服务器和测试响应，在 Chromium / WebKit 的 320、375、390 和 1280 px 视口验证菜单、弹窗、购物车、饮食记录和日期字段，不访问生产账户。浏览器需用 Playwright 安装，测试结束不留常驻进程。

验证线上静态产物可设置 `MENU_LAYOUT_URL=https://zhangjian.dev/menu/ node tests/ui_layout.mjs`，API 请求仍由测试响应接管，不读取或写入用户记录。

图标尺寸再生成：运行 `/opt/menu/venv/bin/python scripts/create_icon.py`，或使用已安装 Pillow 11.3.0 的项目 `.venv/bin/python`；脚本从 `assets/app-icon/calligraphy-source.png` 原稿缩放，无需安装字体。生成提示词见同目录说明。
