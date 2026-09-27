# PhiTogether — 自建服务端版

[English](README.md) | 中文

将多人游戏与 Phigros 玩法结合起来！一个基于 Phigros 玩法的非盈利性开源音游。

本仓库是 [Team-PhiTogether/PhiTogether](https://github.com/Team-PhiTogether/PhiTogether) 的**可自建发行版**：谱面不再从网络谱面社区（PhiZone / PT社区）获取，而是全部来自**你自己的服务端**；排行榜也是服务端上的**本地排行榜**。

## 与上游的差异

- **谱面统一从服务端获取**：移除 PhiZone、PT社区等联网谱面源。用附带的一键拉谱脚本（`server/tools/fetch_phigros_charts.py`，经 GitHub 镜像拉取 Phigros 全量谱面）填充服务端，或手动把 `.pez` / `.zip` 谱面包放进 `server/data/charts/`。本地导入与内置活动谱面保留。
- **按章节浏览的单人游戏**：单人游戏页直接列出服务端全部谱面，按 Phigros 游戏内章节划分（Chapter Legacy、支线、各联动精选集、单曲精选集等；无章节归属的隐藏/愚人节谱面进「隐秘」，其余进「其他」），浏览、下载、游玩合一：难度徽章未下载时点击下载、已下载时点击开玩。列表曲绘后台缓存、无音频预览；独立的「谱面管理」页已移除（清理工具并入设置页）。服务端每曲只存一份音频、下载时按需打包 pez，客户端同曲多难度也共用一份音频，全难度下载不重复占存储。
- **自建排行榜**：玩家在你的服务端注册；每局结束自动上传最佳成绩（离线自动补传），按 RKS（Best30 均值）排名。每个难度还各有一个 Top10 榜：先比分数、同分比精准度，完全相同则并列（单人游戏页展开难度点「榜单」查看，同时只开一个）；结算页也会显示本曲排名（未进前 10 也显示完整名次）。游客可玩，但成绩只存本地。
- **附带精简服务端**（`server/`，Python + FastAPI）：账号（JWT）、谱面包、排行榜，仅此而已。详见 [server/README.md](server/README.md)。
- **多人联机代码保留但禁用**（其依赖的房间服务器不在本发行版内），入口显示维护中。
- **默认采用低性能设备推荐设置**：首次启动默认开启「隐藏距离较远的音符」，关闭背景模糊与界面模糊、降低渲染精度、禁用实时延迟矫正，输入延迟默认 90ms；全部可在设置页自由调整。
- **OneTap 模块构建**：运行 `pnpm build:onetap` 可生成隔离运行的 OneTap 模块。资源从包内读取；设置页勾选框使用 CSS 绘制，兼容 Chrome 89 WebView。
- 无埋点、不请求任何外部谱面/社区服务。

## 自建部署

要求：Python 3.11+、Node.js 18+、pnpm。

```bash
# 1. 安装前端依赖并构建
pnpm install
pnpm build               # 产物在 dist/

# 2. 启动服务端
cd server
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip
python main.py           # 同时提供 API 与构建好的前端，http://127.0.0.1:8000
```

打开 `http://<主机>:8000`，注册账号（首个注册用户为管理员）即可开始游玩。

**添加谱面**：在 `server/` 下运行 `python tools/fetch_phigros_charts.py` 一键拉取 Phigros 全量谱面到 `server/data/charts-lib/`（自动走 GitHub 镜像，重跑只补缺失文件），或手动把 `.pez` / `.zip` 谱面包放入 `server/data/charts/`，然后在游戏内「谱面管理」点「刷新」。损坏的谱面包会被标红并禁止下载。详见 [server/README.md](server/README.md)。

开发模式：`pnpm dev`（前端 :1145）+ `python server/main.py` 同时跑，dev 服务器会把 `/api` 代理到 :8000。

更多服务端配置（数据目录、JWT 密钥、监听地址）见 [server/README.md](server/README.md)。

## 📃 许可证 LICENSE

源代码(不包括多媒体资源)在[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html)许可下分发。

<details>
<summary>简要概述AGPL-3.0协议内容</summary>

- GNU Affero 通用公共许可证 v3.0

    这种最强大的 Copyleft 许可的许可取决于提供许可作品和修改的完整源代码，其中包括在同一许可下使用许可作品的大型作品。 必须保留版权和许可声明。 贡献者明确授予专利权。 当修改版本用于通过网络提供服务时，必须提供修改版本的完整源代码。

    您获得的权限:

    - 商业用途
    - 修改
    - 分发
    - 专利使用
    - 私人使用

    您将被此许可证限制:

    - 责任
    - 保障

    再创作所需的条件:

    - 包含许可和版权声明
    - 标明修改的内容
    - 同样保持开源
    - 作为网络服务使用视为分发
    - 使用相同的许可证(AGPL-3.0)

</details>

对于多媒体资源，我们保留著作权。

> 对于`多媒体资源`的定义
>
> 包括但不限于拓展名包含 `ogg`、`mp3`、`aac`、`wav`、`jp(e)g`、`png`、`svg`、`sketch`、`zip`、`au3`、`aup3-shm`、`aup3-wal`、`flp` 字段的文件。
>
> 包括但不限于文件头标识包含 `ogg`、`mp3`、`aac`、`wav`、`jp(e)g`、`png`、`svg`、`sketch`、`zip`、`au3`、`aup3-shm`、`aup3-wal`、`flp` 文件头标识特征的文件。

## ⭐ 致谢

- 上游项目：[Team-PhiTogether/PhiTogether](https://github.com/Team-PhiTogether/PhiTogether)。
- 基于 [lchzh3473/sim-phi](https://github.com/lchzh3473/sim-phi) 。
- 以及屏幕前的你！

## 曲库缓存与离线游玩

独立网页版和 OneTap 模块版均在首次在线进入「单人游戏」时缓存完整歌曲、章节和难度信息：先展示列表，再后台缓存全部列表缩略图（最长边 192 像素）。首次缓存仍需取得原曲绘，之后直接复用缩略图，仅更新变化的曲绘；页面显示缓存进度，中断后在联网空闲时重试。服务端不可达时仍展示缓存的完整曲库；音频和谱面只在主动下载时获取。

章节最前方新增「已下载」，包含服务端下载及本地导入的可玩谱面，只显示已下载难度；即使为空也保留入口。首次默认选择该章节，以后记住上次选择。选曲页使用独立滚动区域，支持鼠标滚轮和触屏浏览；游玩配置内的「清理曲库信息和缩略图」不会删除已下载谱面、收藏或成绩。

保持游戏页面打开，即可在服务端断连后继续游玩已下载谱面。符合计分条件的单局先保存到本地，再尝试上传；结算页和个人卡片立即按现有规则更新 RKS（历史最高精准度、最佳 30 张均值），显示待同步状态。恢复连接、启动游戏及页面可见且不在游玩时每 30 秒重试补传。此前同步的服务端 Best30 作为本地 RKS 基线，尚未同步过时标注本地估算。游客成绩不自动并入登录账号；独立版各账号的成绩及补传队列隔离，模块版复用宿主隔离存储。无法确认归属的旧版无账号队列保留原数据，不冒然传给其他账号。离线能力依赖浏览器或宿主本地存储，暂不保证断网后全新打开应用。

OneTap 个人卡片保留「本地排行榜」，隐藏登录、切换账号、退出登录和重试登录；独立版保留账号操作。

专项检查：`node script/check-library-cache.mjs`、`node script/check-offline-records.mjs`。

谱面导入还减少了一次完整文件缓冲区复制，并释放 OneTap 临时下载对象和解包线程。解包超时会明确失败，不再导入不完整内容；暂不扩大下载并发或更改谱面包协议。
