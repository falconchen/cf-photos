#!/usr/bin/env bash
#
# 用 Workers Builds REST API 在本地配置构建设置（wrangler 没有对应子命令）
#
# 做两件事：把 Deploy command 改成 npm run deploy:ci，并写入 Bark 通知要用的
# 构建变量 BARK_KEY / BARK_SERVER。这些都是构建期配置，跟 wrangler secret put
# 管的运行时 Secrets 是两套东西，互相看不见。
#
# 默认只读：打印 worker tag、触发器、当前构建配置和已有的构建变量，什么都不改。
# 真正下笔要显式加 --apply。
#
# 注意 environment_variables 的 PATCH 是整组覆盖，而 GET 回来的 secret 值是打码的，
# 无法先读后合。所以 --apply 之前先看只读输出：如果那里已经有别的 secret，
# 得把它们的值一起用 EXTRA_VARS 传进来，否则会被这次写入抹掉。
#
# 前置条件:
#   CLOUDFLARE_API_TOKEN  必须是「用户级」Token（账户级不支持），权限两项：
#                         Workers Builds Configuration: Edit + Workers Scripts: Read
#                         https://dash.cloudflare.com/profile/api-tokens
#   CLOUDFLARE_ACCOUNT_ID 账户 ID，可用 npx wrangler whoami 查
#   BARK_KEY              --apply 时必填；没设会交互式询问
#   BARK_SERVER           选填，自建 Bark 服务器，默认走 api.day.app
#   EXTRA_VARS            选填，形如 'FOO=bar,BAZ=qux' 的额外构建变量，一并写入
#
# 用法: scripts/setup-workers-build.sh [--apply] [--worker NAME] [--branch main]
#
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
APPLY=0
WORKER="${WORKER_NAME:-cf-photos}"
BRANCH="main"
DEPLOY_COMMAND="npm run deploy:ci"

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1; shift ;;
        --worker) WORKER="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done

: "${CLOUDFLARE_API_TOKEN:?请先导出 CLOUDFLARE_API_TOKEN（用户级 Token）}"
: "${CLOUDFLARE_ACCOUNT_ID:?请先导出 CLOUDFLARE_ACCOUNT_ID（npx wrangler whoami 可查）}"
command -v jq >/dev/null || { echo "需要 jq" >&2; exit 1; }

# 发一次 API 请求；success 为 false 时打印 errors 并退出，避免把失败当成功
cf() {
    local method="$1" path="$2" body="${3:-}"
    local args=(-sS --request "$method" --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
    [ -n "$body" ] && args+=(--header "Content-Type: application/json" --data "$body")
    local out
    out=$(curl "${args[@]}" "${API}${path}")
    if [ "$(printf '%s' "$out" | jq -r '.success // false')" != "true" ]; then
        echo "API 调用失败: $method $path" >&2
        printf '%s\n' "$out" | jq '.errors // .' >&2
        exit 1
    fi
    printf '%s' "$out"
}

echo "== Worker: ${WORKER}"
TAG=$(cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts" \
    | jq -r --arg n "$WORKER" '.result[] | select(.id == $n) | .tag')
[ -n "$TAG" ] || { echo "没找到名为 ${WORKER} 的 Worker" >&2; exit 1; }
echo "   tag: ${TAG}"

TRIGGERS=$(cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/builds/workers/${TAG}/triggers")
echo "== 触发器"
printf '%s\n' "$TRIGGERS" | jq -r '.result[] | "   \(.trigger_uuid)  \(.trigger_name // "-")  branches=\(.branch_includes // [] | join(","))"'

# 优先选 branch_includes 命中目标分支的触发器；只有一个触发器时直接用它
UUID=$(printf '%s\n' "$TRIGGERS" | jq -r --arg b "$BRANCH" \
    '[.result[] | select((.branch_includes // []) | index($b))] | .[0].trigger_uuid // empty')
if [ -z "$UUID" ]; then
    UUID=$(printf '%s\n' "$TRIGGERS" | jq -r 'if (.result | length) == 1 then .result[0].trigger_uuid else empty end')
fi
[ -n "$UUID" ] || { echo "无法确定要改哪个触发器，请照上面的列表手动指定" >&2; exit 1; }
echo "   选中: ${UUID}"

echo "== 当前构建配置"
printf '%s\n' "$TRIGGERS" | jq --arg u "$UUID" '.result[] | select(.trigger_uuid == $u)
    | {build_command, deploy_command, root_directory, build_caching_enabled}'

echo "== 当前构建变量（secret 的值是打码的）"
cf GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/builds/triggers/${UUID}/environment_variables" | jq '.result'

if [ "$APPLY" -ne 1 ]; then
    echo
    echo "以上为只读预览。确认无误后加 --apply 执行："
    echo "   Deploy command → ${DEPLOY_COMMAND}"
    echo "   写入构建变量   → BARK_KEY(secret)${BARK_SERVER:+, BARK_SERVER}"
    exit 0
fi

if [ -z "${BARK_KEY:-}" ]; then
    read -r -s -p "Bark device key: " BARK_KEY
    echo
fi
[ -n "$BARK_KEY" ] || { echo "BARK_KEY 不能为空" >&2; exit 1; }

echo "== 更新 Deploy command"
cf PATCH "/accounts/${CLOUDFLARE_ACCOUNT_ID}/builds/triggers/${UUID}" \
    "$(jq -nc --arg c "$DEPLOY_COMMAND" '{deploy_command: $c}')" | jq '.result | {deploy_command}'

echo "== 写入构建变量"
VARS=$(jq -nc --arg k "$BARK_KEY" '{BARK_KEY: {value: $k, is_secret: true}}')
if [ -n "${BARK_SERVER:-}" ]; then
    VARS=$(printf '%s' "$VARS" | jq -c --arg s "$BARK_SERVER" '. + {BARK_SERVER: {value: $s, is_secret: false}}')
fi
if [ -n "${EXTRA_VARS:-}" ]; then
    VARS=$(printf '%s' "$VARS" | jq -c --arg e "$EXTRA_VARS" \
        '. + ($e | split(",") | map(select(length > 0) | split("=") | {(.[0]): {value: (.[1:] | join("=")), is_secret: true}}) | add // {})')
fi
cf PATCH "/accounts/${CLOUDFLARE_ACCOUNT_ID}/builds/triggers/${UUID}/environment_variables" "$VARS" \
    | jq '.result | with_entries(.value |= (if .is_secret then "***" else .value end))'

echo
echo "完成。下次推送到 ${BRANCH} 时生效；也可以手动触发一次构建验证："
echo "   curl -sS -X POST \"${API}/accounts/\${CLOUDFLARE_ACCOUNT_ID}/builds/triggers/${UUID}/builds\" \\"
echo "     -H \"Authorization: Bearer \$CLOUDFLARE_API_TOKEN\" -H 'Content-Type: application/json' \\"
echo "     -d '{\"branch\":\"${BRANCH}\"}' | jq"
