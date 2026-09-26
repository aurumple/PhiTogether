#!/bin/sh
# PhiTogether 集成后端发布安装（在树莓派上以 maple 运行；完全离线、幂等）。
# 用法：解压发布包后执行 sh install-release.sh；随后由 root 的 install.sh 安装 systemd 单元。
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT=/home/maple/phitogether
VER="$(cat "$SRC/VERSION")"
REL="$ROOT/releases/$VER"

if [ ! -d "$REL" ]; then
    mkdir -p "$REL"
    cp -r "$SRC/server" "$REL/server"
    # 离线依赖：venv 不带 pip，用 wheelhouse 里的 pip wheel 自举后本地安装。
    python3 -m venv --without-pip "$REL/venv"
    PIP_WHEEL="$(ls "$SRC"/wheelhouse/pip-*.whl | head -1)"
    "$REL/venv/bin/python" "$PIP_WHEEL"/pip install --no-index --find-links "$SRC/wheelhouse" \
        fastapi uvicorn aiosqlite PyJWT
fi

ln -sfn "$REL" "$ROOT/current"
mkdir -p "$ROOT/data"
if [ ! -f "$ROOT/run.env" ]; then
    cp "$SRC/run.env.example" "$ROOT/run.env"
    echo "已生成 $ROOT/run.env——请填入 PT_ONETAP_SERVICE_KEY（≥32字符随机值）后重启服务。"
fi
echo "INSTALLED $VER -> $ROOT/current"
