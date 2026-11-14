#!/usr/bin/env bash
# 交付前自检：不是“能打开页面”就算过，而是把已知的翻车点逐条验一遍。
#   bash preflight.sh          # 运行态检查
#   bash preflight.sh --full   # 额外跑 core 测试套件
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

APP_PID_FILE="$SCRIPT_DIR/app_dev.pid"
WD_PID_FILE="$SCRIPT_DIR/watchdog.pid"
WD_BEAT="$SCRIPT_DIR/watchdog.beat"
LOCK_DIR="$SCRIPT_DIR/.start.lock"
APP_PORT="$(grep -E '^PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r')"
APP_PORT="${APP_PORT:-3007}"

PASS=0
FAIL=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }

app_pids() {
    local dir pid argv0 argv1 cwd
    for dir in /proc/[0-9]*; do
        pid="${dir#/proc/}"
        argv0=""
        argv1=""
        {
            IFS= read -r -d '' argv0
            IFS= read -r -d '' argv1
        } < "$dir/cmdline" 2>/dev/null || continue
        [[ "${argv0##*/}" == "node" ]] || continue
        [[ "$argv1" == *"core/client.js"* ]] || continue
        cwd="$(readlink -f "$dir/cwd" 2>/dev/null || true)"
        [[ "$cwd" == "$SCRIPT_DIR" ]] || continue
        echo "$pid"
    done
}

http_code() {
    curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null || echo "000"
}

front_hash() {
    local body
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:$1/" 2>/dev/null)" || return 1
    printf '%s' "$body" | md5sum | cut -d' ' -f1
}

echo "运行态"

pids="$(app_pids)"
pid_count="$(printf '%s\n' "$pids" | grep -c . || true)"
if [[ "$pid_count" == "1" ]]; then
    ok "主进程唯一：$(printf '%s' "$pids")"
else
    bad "主进程数量为 ${pid_count}，应为 1（重复实例会重复购买）：$(printf '%s' "$pids" | tr '\n' ' ')"
fi

recorded="$(tr -d '[:space:]' < "$APP_PID_FILE" 2>/dev/null || true)"
if [[ -n "$recorded" && "$recorded" == "$pids" ]]; then
    ok "pid 文件与运行进程一致"
else
    bad "pid 文件记录 '${recorded}' 与实际 '${pids}' 不一致"
fi

for port in "$APP_PORT" 3000; do
    code="$(http_code "$port")"
    if [[ "$code" == "200" ]]; then
        ok "${port} 首页 200"
    else
        bad "${port} 首页返回 ${code}"
    fi
done

if [[ "$APP_PORT" != "3000" ]]; then
    h_edge="$(front_hash 3000 2>/dev/null || true)"
    h_main="$(front_hash "$APP_PORT" 2>/dev/null || true)"
    if [[ -n "$h_edge" && "$h_edge" == "$h_main" ]]; then
        ok "3000 与 ${APP_PORT} 返回同一份前端"
    else
        bad "3000 与 ${APP_PORT} 内容不一致，3000 可能指向别的实例"
    fi
fi

wd_pid="$(tr -d '[:space:]' < "$WD_PID_FILE" 2>/dev/null || true)"
if [[ "$wd_pid" =~ ^[0-9]+$ ]] && kill -0 "$wd_pid" 2>/dev/null \
    && tr '\0' ' ' < "/proc/$wd_pid/cmdline" 2>/dev/null | grep -q 'watchdog.sh run'; then
    ok "看门狗在跑：PID ${wd_pid}"
    beat="$(tr -d '[:space:]' < "$WD_BEAT" 2>/dev/null || true)"
    if [[ "$beat" =~ ^[0-9]+$ ]]; then
        age=$(( $(date +%s) - beat ))
        if (( age <= 180 )); then
            ok "心跳 ${age}s 前"
        else
            bad "心跳已 ${age}s 未更新（间隔 60s，超过 180s 视为卡死）"
        fi
    else
        bad "没有心跳记录"
    fi
else
    bad "看门狗未运行"
fi

if [[ -d "$LOCK_DIR" ]]; then
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
        ok "启动锁被 PID ${holder} 持有（有 start.sh 正在执行）"
    else
        bad "启动锁残留但 holder 已死，会挡住后续启动"
    fi
else
    ok "无启动锁残留"
fi

if [[ -s "$SCRIPT_DIR/app_dev.log" ]]; then
    ok "运行日志非空（$(stat -c %s "$SCRIPT_DIR/app_dev.log") 字节）"
else
    bad "运行日志为空"
fi

if [[ -s "$SCRIPT_DIR/app_dev.log.prev" ]]; then
    ok "上一轮日志已保留为 app_dev.log.prev"
else
    printf '  - 尚无 app_dev.log.prev（首次启动，正常）\n'
fi

dumps="$(ls "$SCRIPT_DIR"/core.[0-9]* 2>/dev/null | wc -l)"
if [[ "$dumps" == "0" ]]; then
    ok "无崩溃转储"
else
    bad "发现 ${dumps} 个崩溃转储：$(ls -lh "$SCRIPT_DIR"/core.[0-9]* 2>/dev/null | awk '{print $9"("$5")"}' | tr '\n' ' ')"
fi

if [[ "${1:-}" == "--full" ]]; then
    echo
    echo "测试套件"
    if (cd "$SCRIPT_DIR/core" && node --test tests/*.test.js > /tmp/preflight-tests.log 2>&1); then
        summary="$(grep -E '^# (pass|fail|skipped)' /tmp/preflight-tests.log | tr '\n' ' ')"
        ok "core 测试：${summary}"
    else
        bad "core 测试失败，详见 /tmp/preflight-tests.log"
    fi
fi

echo
if (( FAIL == 0 )); then
    printf '\033[32m全部通过：%d 项\033[0m\n' "$PASS"
    exit 0
fi
printf '\033[31m%d 项失败、%d 项通过\033[0m\n' "$FAIL" "$PASS"
exit 1
