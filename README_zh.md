# PhiTogether — 自建服务端版

[English](README.md) | 中文

将多人游戏与 Phigros 玩法结合起来！一个基于 Phigros 玩法的非盈利性开源音游。

本仓库是 [Team-PhiTogether/PhiTogether](https://github.com/Team-PhiTogether/PhiTogether) 的**可自建发行版**：谱面不再从网络谱面社区（PhiZone / PT社区）获取，而是全部来自**你自己的服务端**；排行榜也是服务端上的**本地排行榜**。

## 与上游的差异

- **谱面统一从服务端获取**：移除 PhiZone、PT社区等联网谱面源。把 `.pez` / `.zip` 谱面包放进服务端 `data/charts/` 目录，玩家在游戏内「谱面管理」按需下载。本地导入与内置活动谱面保留。
- **自建排行榜**：玩家在你的服务端注册；每局结束自动上传最佳成绩（离线自动补传），按 RKS（Best30 均值）排名。游客可玩，但成绩只存本地。
- **附带精简服务端**（`server/`，Python + FastAPI）：账号（JWT）、谱面包、排行榜，仅此而已。详见 [server/README.md](server/README.md)。
- **多人联机代码保留但禁用**（其依赖的房间服务器不在本发行版内），入口显示维护中。
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

**添加谱面**：把 `.pez` / `.zip` 谱面包放入 `server/data/charts/`，在游戏内「谱面管理」点「刷新」。损坏的谱面包会被标红并禁止下载。

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
