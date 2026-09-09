#!/usr/bin/env bash
#
# cf-photos WebDAV 每日增量备份
#
# 把 WebDAV 上的 i/ 目录镜像到本地。图片名带时间戳且写入后不再修改，
# 因此增量策略有两层：
#   1) 目录级：只遍历「上次成功备份日期 - GRACE_DAYS」之后的 年/月/日 目录；
#   2) 文件级：本地已存在且字节数与远端一致的文件直接跳过（断点续传靠这层兜底）。
# 只要有任何文件失败，就不推进 last-success，下次仍会重扫这段区间。
#
# 用法: scripts/webdav-backup.sh [选项]
#   -c, --config FILE   读取 WEBDAV_* 的 env 文件（默认：仓库内 .dev.vars）
#   -d, --dest DIR      备份根目录（默认：$BACKUP_DIR 或 ~/cf-photos-backup）
#       --full          忽略状态文件，全量遍历远端
#       --since DATE    从指定日期开始遍历（YYYY-MM-DD 或 YYYYMMDD）
#       --prune         远端已删除的文件移入 .trash/（隐含 --full，不做真删除）
#       --dry-run       只报告要下载/清理什么，不写盘
#   -q, --quiet         只输出警告和错误
#   -h, --help          显示帮助
#
# 每天跑一次（crontab -e，凌晨 3:20）：
#   20 3 * * * /path/to/cf-photos/scripts/webdav-backup.sh -c /path/to/.dev.vars >/dev/null 2>&1
# macOS 建议用 launchd（见 --help 输出）。
set -u
# 固定排序规则，sort/comm 两边必须一致，否则 --prune 的差集会算错。
export LC_ALL=C

VERSION=1.0.0

# ---------------------------------------------------------------- 参数与默认值

CONFIG=""
DEST="${BACKUP_DIR:-}"
FULL=0
SINCE=""
PRUNE=0
DRY_RUN=0
QUIET=0

usage() {
    sed -n '2,/^set -u/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^set -u/d'
    cat <<'EOF'

launchd 示例（~/Library/LaunchAgents/com.cf-photos.backup.plist）：
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>com.cf-photos.backup</string>
    <key>ProgramArguments</key><array>
      <string>/bin/bash</string>
      <string>/path/to/cf-photos/scripts/webdav-backup.sh</string>
      <string>-c</string><string>/path/to/.dev.vars</string>
    </array>
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>20</integer></dict>
    <key>RunAtLoad</key><false/>
  </dict></plist>
  launchctl load ~/Library/LaunchAgents/com.cf-photos.backup.plist
EOF
}

need_value() { [ "$2" -ge 2 ] || { echo "$1 需要一个参数" >&2; exit 1; }; }

while [ $# -gt 0 ]; do
    case "$1" in
        -c|--config) need_value "$1" $#; CONFIG="$2"; shift 2 ;;
        -d|--dest)   need_value "$1" $#; DEST="$2"; shift 2 ;;
        --full)      FULL=1; shift ;;
        --since)     need_value "$1" $#; SINCE="$2"; shift 2 ;;
        --prune)     PRUNE=1; FULL=1; shift ;;
        --dry-run)   DRY_RUN=1; shift ;;
        -q|--quiet)  QUIET=1; shift ;;
        -h|--help)   usage; exit 0 ;;
        *) echo "未知参数: $1（-h 查看用法）" >&2; exit 1 ;;
    esac
done

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
[ -n "$CONFIG" ] || CONFIG="$SCRIPT_DIR/../.dev.vars"
[ -n "$DEST" ] || DEST="$HOME/cf-photos-backup"

# ---------------------------------------------------------------- 日志与退出

STATE=""
LOG_FILE=""
LOCK_DIR=""
TMP_DIR=""

log() { [ "$QUIET" -eq 1 ] || _emit "INFO " "$*"; }
warn() { _emit "WARN " "$*"; }
err()  { _emit "ERROR" "$*"; }

# 统一格式并同时写日志文件。
_emit() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S') [$1] $2"
    printf '%s\n' "$line" >&2
    [ -n "$LOG_FILE" ] && printf '%s\n' "$line" >>"$LOG_FILE"
    return 0
}

cleanup() {
    [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"
    # 锁目录里有 pid 文件，rmdir 删不掉，只能整个移除。
    [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] && rm -rf "$LOCK_DIR"
    return 0
}

die() { err "$*"; exit 1; }

# ---------------------------------------------------------------- 配置读取

# 从 dotenv 文件里取单个键，容忍引号和行尾空白。
read_env() {
    local key="$1" file="$2" value
    value=$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=//p" "$file" | head -1)
    value="${value%$'\r'}"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    printf '%s' "$value"
}

[ -f "$CONFIG" ] || die "找不到配置文件: $CONFIG"
WEBDAV_URL=$(read_env WEBDAV_URL "$CONFIG")
WEBDAV_USERNAME=$(read_env WEBDAV_USERNAME "$CONFIG")
WEBDAV_PASSWORD=$(read_env WEBDAV_PASSWORD "$CONFIG")
TIMEZONE_OFFSET=$(read_env TIMEZONE_OFFSET "$CONFIG")
[ -n "$WEBDAV_URL" ] && [ -n "$WEBDAV_USERNAME" ] && [ -n "$WEBDAV_PASSWORD" ] || die "配置缺少 WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD"
case "$WEBDAV_URL" in https://*) ;; *) die "WEBDAV_URL 必须是 https:// 开头" ;; esac
case "$WEBDAV_URL" in *@*|*\?*|*\#*) die "WEBDAV_URL 不能带凭据或查询串" ;; esac

# 与 Worker 保持一致：目录日期用带偏移的本地时间，默认 +8；支持 5.5、-3 这类取值。
case "$TIMEZONE_OFFSET" in ''|*[!0-9.+-]*) TIMEZONE_OFFSET=8 ;; esac
OFFSET_MIN=$(awk -v v="$TIMEZONE_OFFSET" 'BEGIN{ if (v < -12 || v > 14) v = 8; printf "%d", v * 60 }' 2>/dev/null)
case "$OFFSET_MIN" in ''|*[!0-9-]*) OFFSET_MIN=480 ;; esac
REMOTE_ROOT="${REMOTE_ROOT:-i}"
GRACE_DAYS="${GRACE_DAYS:-2}"
TRASH_KEEP_DAYS="${TRASH_KEEP_DAYS:-30}"
MAX_RETRY="${MAX_RETRY:-3}"

# 拆出 base 路径：去掉 scheme 和 host，保证首尾各有一个 /
_rest="${WEBDAV_URL#https://}"
BASE_HOST="${_rest%%/*}"
case "$_rest" in
    */*) BASE_PATH="/${_rest#*/}" ;;
    *)   BASE_PATH="/" ;;
esac
while :; do case "$BASE_PATH" in */) BASE_PATH="${BASE_PATH%/}" ;; *) break ;; esac; done
BASE_PATH="$BASE_PATH/"
BASE_URL="https://$BASE_HOST$BASE_PATH"

# ---------------------------------------------------------------- 目录与锁

DEST="${DEST%/}"
mkdir -p "$DEST" || die "无法创建备份目录: $DEST"
DEST=$(cd "$DEST" && pwd)
STATE="$DEST/.backup-state"
mkdir -p "$STATE" || die "无法创建状态目录: $STATE"
chmod 700 "$STATE" 2>/dev/null
LOG_FILE="$STATE/backup.log"
# 日志超过 5 MB 就滚动一次，只留一份旧的。
if [ -f "$LOG_FILE" ] && [ "$(wc -c <"$LOG_FILE")" -gt 5242880 ]; then mv "$LOG_FILE" "$LOG_FILE.1"; fi

LOCK_DIR="$STATE/lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    old_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        LOCK_DIR=""; err "另一个备份进程正在运行 (pid $old_pid)"; exit 2
    fi
    warn "清理残留锁 ${old_pid:-未知}"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || { LOCK_DIR=""; die "无法获取锁"; }
fi
echo $$ >"$LOCK_DIR/pid"

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cf-photos-backup.XXXXXX") || die "无法创建临时目录"
trap cleanup EXIT INT TERM HUP

# 凭据只落在 600 的 curl 配置文件里，不进命令行（ps 可见）也不进环境变量。
CURLRC="$TMP_DIR/curlrc"
umask 077
{
    printf 'user = "%s:%s"\n' "$WEBDAV_USERNAME" "$WEBDAV_PASSWORD"
    printf 'silent\nshow-error\nconnect-timeout = 20\nmax-time = 900\nretry = 2\nretry-delay = 3\n'
} >"$CURLRC"
unset WEBDAV_PASSWORD

# ---------------------------------------------------------------- 日期工具

# 当前日期，按 TIMEZONE_OFFSET 偏移，输出 YYYYMMDD。
today() {
    local off="$OFFSET_MIN" sign=+ out
    case "$off" in -*) sign=-; off="${off#-}" ;; esac
    # BSD date 用 -v 偏移，GNU date 用 -d；两边都验证输出再采信。分钟为单位以支持半小时时区。
    out=$(date -u -v"${sign}${off}M" +%Y%m%d 2>/dev/null)
    is_ymd "$out" || out=$(date -u -d "${sign}${off} minutes" +%Y%m%d 2>/dev/null)
    is_ymd "$out" || out=$(date -u +%Y%m%d)
    printf '%s' "$out"
}

# YYYYMMDD 往前推 N 天；失败返回非零。
date_minus() {
    local d="$1" n="$2" out
    # BSD date 的 -v/-f 必须排在日期操作数之前，顺序错了会被当成多余参数静默忽略。
    out=$(date -j -v-"${n}"d -f %Y%m%d "$d" +%Y%m%d 2>/dev/null)
    is_ymd "$out" || out=$(date -d "$d -${n} days" +%Y%m%d 2>/dev/null)
    is_ymd "$out" || return 1
    printf '%s' "$out"
}

# 是否是 8 位 YYYYMMDD。
is_ymd() {
    case "${1:-}" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) return 0 ;; *) return 1 ;; esac
}

# 归一化 --since 的写法为 YYYYMMDD。
normalize_date() {
    local d="$1"
    d="${d//-/}"; d="${d//\//}"
    is_ymd "$d" || return 1
    printf '%s' "$d"
}

TODAY=$(today)
# 只扫了一段日期就 prune，会把没扫到的旧文件误判成远端已删除。
[ "$PRUNE" -eq 1 ] && [ -n "$SINCE" ] && die "--prune 需要全量扫描，不能与 --since 同用"
if [ -n "$SINCE" ]; then
    SINCE=$(normalize_date "$SINCE") || die "--since 日期格式应为 YYYY-MM-DD"
elif [ "$FULL" -eq 1 ]; then
    SINCE=""
elif [ -f "$STATE/last-success" ]; then
    last=$(tr -dc '0-9' <"$STATE/last-success")
    if is_ymd "$last"; then
        SINCE=$(date_minus "$last" "$GRACE_DAYS") || { SINCE=""; warn "日期计算失败，本次改为全量遍历"; }
    else
        warn "状态文件损坏，本次改为全量遍历"
    fi
fi

# ---------------------------------------------------------------- WebDAV 访问

PROPFIND_BODY='<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'

# 百分号解码 href；含可疑字符时返回非零。
url_decode() {
    local s="$1" out
    # 控制字符只可能以 %00-%1F / %7F 的形式混进来，解码前先挡掉，省得再扫一遍字节。
    case "$s" in
        *\\*) return 1 ;;
        *%0[0-9A-Fa-f]*|*%1[0-9A-Fa-f]*|*%7[Ff]*) return 1 ;;
    esac
    out=$(printf '%b' "${s//%/\\x}") || return 1
    case "$out" in
        *../*|*/./*|*/..|*/.) return 1 ;;
    esac
    printf '%s' "$out"
}

# PROPFIND Depth:1，输出 "d|f<TAB>相对键<TAB>字节数"，相对键是 i/ 起头的路径。
propfind() {
    local rel="$1" code attempt=1
    # 目录列举失败会让整批文件被漏掉，所以这里比下载更执着地重试。
    while :; do
        code=$(curl -K "$CURLRC" -o "$TMP_DIR/resp.xml" -w '%{http_code}' \
            -X PROPFIND -H 'Depth: 1' -H 'Content-Type: application/xml; charset=utf-8' \
            --data "$PROPFIND_BODY" "$BASE_URL$rel" 2>>"$LOG_FILE")
        [ "$code" = "207" ] && break
        if [ "$code" = "404" ]; then err "PROPFIND $rel: 远端目录不存在"; return 1; fi
        if [ "$attempt" -ge "$MAX_RETRY" ]; then
            err "PROPFIND $rel 返回 HTTP $code（000 表示连接中断或超时）"
            return 1
        fi
        warn "PROPFIND $rel 返回 HTTP $code，第 $attempt 次重试"
        attempt=$((attempt + 1))
        sleep $((attempt * 2))
    done
    if grep -qi '<!DOCTYPE\|<!ENTITY' "$TMP_DIR/resp.xml"; then err "PROPFIND $rel 返回了不支持的 XML"; return 1; fi

    # 去命名空间前缀，把每个 response 压成一行再逐行提取。
    tr '\n' ' ' <"$TMP_DIR/resp.xml" \
        | sed -e 's/<[A-Za-z0-9_.-]\{1,\}:/</g' -e 's|</[A-Za-z0-9_.-]\{1,\}:|</|g' -e 's|</response>|</response>\
|g' \
    | while IFS= read -r entry; do
        case "$entry" in *"<href"*) ;; *) continue ;; esac
        href=$(printf '%s' "$entry" | sed -n 's|.*<href[^>]*>\([^<]*\)</href>.*|\1|p' | head -1)
        [ -n "$href" ] || continue
        # href 可能是完整 URL，也可能只是绝对路径。
        case "$href" in
            https://"$BASE_HOST"/*) path="/${href#https://$BASE_HOST/}" ;;
            http://*|https://*) continue ;;
            /*) path="$href" ;;
            *) continue ;;
        esac
        path=$(url_decode "$path") || { warn "跳过异常 href: $href"; continue; }
        case "$path" in "$BASE_PATH"*) ;; *) continue ;; esac
        key="${path#$BASE_PATH}"
        [ -n "$key" ] || continue
        if printf '%s' "$entry" | grep -q '<collection'; then
            case "$key" in */) ;; *) key="$key/" ;; esac
            [ "$key" = "$rel" ] && continue
            printf 'd\t%s\t0\n' "$key"
        else
            size=$(printf '%s' "$entry" | sed -n 's|.*<getcontentlength[^>]*>\([0-9]*\)</getcontentlength>.*|\1|p' | head -1)
            printf 'f\t%s\t%s\n' "$key" "${size:-0}"
        fi
    done
}

# 目录是否落在 SINCE 之后；只对 年/月/日 这种纯数字层级做裁剪。
should_visit() {
    local rel="$1" tail digits bound
    [ -n "$SINCE" ] || return 0
    tail="${rel#$REMOTE_ROOT/}"
    tail="${tail%/}"
    digits=$(printf '%s' "$tail" | tr -d '/')
    case "$tail" in
        [0-9][0-9][0-9][0-9]|[0-9][0-9][0-9][0-9]/[0-9][0-9]|[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]) ;;
        *) return 0 ;;  # 结构之外的目录一律遍历，宁可多扫
    esac
    bound=$(printf '%s' "$SINCE" | cut -c1-${#digits})
    [ "$digits" -ge "$bound" ]
}

# ---------------------------------------------------------------- 主流程

NEW=0; SKIP=0; FAIL=0; BYTES=0; DIRS=0
SEEN="$TMP_DIR/seen"
: >"$SEEN"

# 单个文件：大小一致就跳过，否则下载到 .part 再原子改名。
fetch_file() {
    local key="$1" remote_size="$2" local_path="$3" attempt=1 code got
    if [ -f "$local_path" ]; then
        got=$(wc -c <"$local_path" | tr -d ' ')
        if [ "$got" = "$remote_size" ]; then SKIP=$((SKIP + 1)); return 0; fi
        # 个别服务器不给 getcontentlength，无从比对，已有的非空文件就当作已备份。
        if [ "$remote_size" -le 0 ] && [ -s "$local_path" ]; then SKIP=$((SKIP + 1)); return 0; fi
        warn "大小不符，重新下载: $key（本地 $got / 远端 $remote_size）"
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] 将下载 $key ($remote_size 字节)"
        NEW=$((NEW + 1)); BYTES=$((BYTES + remote_size)); return 0
    fi
    mkdir -p "$(dirname "$local_path")" || { err "无法创建目录: $(dirname "$local_path")"; FAIL=$((FAIL + 1)); return 1; }
    while [ "$attempt" -le "$MAX_RETRY" ]; do
        code=$(curl -K "$CURLRC" -R -o "$local_path.part" -w '%{http_code}' \
            "$BASE_URL$key" 2>>"$LOG_FILE")
        if [ "$code" = "200" ]; then
            got=$(wc -c <"$local_path.part" | tr -d ' ')
            if [ "$remote_size" -gt 0 ] && [ "$got" != "$remote_size" ]; then
                warn "下载不完整: $key（$got/$remote_size），第 $attempt 次重试"
            else
                mv "$local_path.part" "$local_path" || { err "改名失败: $key"; FAIL=$((FAIL + 1)); return 1; }
                NEW=$((NEW + 1)); BYTES=$((BYTES + got))
                log "下载 $key ($got 字节)"
                return 0
            fi
        else
            warn "GET $key 返回 HTTP $code，第 $attempt 次重试"
        fi
        rm -f "$local_path.part"
        attempt=$((attempt + 1))
        [ "$attempt" -le "$MAX_RETRY" ] && sleep $((attempt * 2))
    done
    err "下载失败: $key"
    FAIL=$((FAIL + 1))
    return 1
}

log "cf-photos 备份 v$VERSION 开始：$BASE_URL$REMOTE_ROOT/ → $DEST"
if [ -n "$SINCE" ]; then log "增量模式，只遍历 $SINCE 之后的日期目录（--full 可全量）"; else log "全量遍历模式"; fi
[ "$DRY_RUN" -eq 1 ] && log "dry-run：不会写入任何文件"

# 逐层 BFS，避免 bash 递归深度问题。
CUR="$TMP_DIR/level.cur"; NEXT="$TMP_DIR/level.next"
printf '%s/\n' "$REMOTE_ROOT" >"$CUR"
while [ -s "$CUR" ]; do
    : >"$NEXT"
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        DIRS=$((DIRS + 1))
        propfind "$dir" >"$TMP_DIR/entries" || { FAIL=$((FAIL + 1)); continue; }
        while IFS="$(printf '\t')" read -r type key size; do
            [ -n "$key" ] || continue
            case "$key" in "$REMOTE_ROOT"/*) ;; *) continue ;; esac
            if [ "$type" = "d" ]; then
                if should_visit "$key"; then printf '%s\n' "$key" >>"$NEXT"; fi
            else
                printf '%s\n' "$key" >>"$SEEN"
                fetch_file "$key" "$size" "$DEST/$key"
            fi
        done <"$TMP_DIR/entries"
    done <"$CUR"
    sort "$NEXT" >"$CUR"
done

# ---------------------------------------------------------------- 清理远端已删除的文件

PRUNED=0
if [ "$PRUNE" -eq 1 ]; then
    if [ "$FAIL" -gt 0 ]; then
        warn "本次有失败，跳过 --prune（避免把没扫到的文件当成已删除）"
    else
        : >"$TMP_DIR/local.raw"
        find "$DEST/$REMOTE_ROOT" -type f ! -name '*.part' >"$TMP_DIR/local.raw" 2>/dev/null
        : >"$TMP_DIR/local.rel"
        while IFS= read -r f; do printf '%s\n' "${f#$DEST/}" >>"$TMP_DIR/local.rel"; done <"$TMP_DIR/local.raw"
        sort "$TMP_DIR/local.rel" >"$TMP_DIR/local"
        sort "$SEEN" >"$TMP_DIR/remote"
        trash="$DEST/.trash/$(date '+%Y%m%d-%H%M%S')"
        while IFS= read -r key; do
            [ -n "$key" ] || continue
            PRUNED=$((PRUNED + 1))
            if [ "$DRY_RUN" -eq 1 ]; then
                log "[dry-run] 将移入回收站 $key"
            else
                mkdir -p "$trash/$(dirname "$key")"
                mv "$DEST/$key" "$trash/$key" && log "远端已删除，移入回收站: $key"
            fi
        done < <(comm -23 "$TMP_DIR/local" "$TMP_DIR/remote")
        # 回收站按天数过期，真正的删除留给这一步。
        if [ "$DRY_RUN" -eq 0 ] && [ -d "$DEST/.trash" ]; then
            find "$DEST/.trash" -mindepth 1 -maxdepth 1 -type d -mtime +"$TRASH_KEEP_DAYS" -exec rm -rf {} + 2>/dev/null
        fi
    fi
fi

# ---------------------------------------------------------------- 收尾

if [ "$DRY_RUN" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
    # 全量扫描时清单就是远端全貌；增量只扫了一段日期，所以与旧清单取并集。
    if [ -n "$SINCE" ] && [ -f "$STATE/manifest.txt" ]; then
        sort -u "$SEEN" "$STATE/manifest.txt" >"$TMP_DIR/manifest.new"
    else
        sort -u "$SEEN" >"$TMP_DIR/manifest.new"
    fi
    mv "$TMP_DIR/manifest.new" "$STATE/manifest.txt"
    printf '%s\n' "$TODAY" >"$STATE/last-success"
fi

human() {
    local b="$1"
    if [ "$b" -ge 1073741824 ]; then awk -v b="$b" 'BEGIN{printf "%.2f GB", b/1073741824}'
    elif [ "$b" -ge 1048576 ]; then awk -v b="$b" 'BEGIN{printf "%.2f MB", b/1048576}'
    elif [ "$b" -ge 1024 ]; then awk -v b="$b" 'BEGIN{printf "%.1f KB", b/1024}'
    else printf '%s B' "$b"; fi
}

TOTAL=$(wc -l <"$SEEN" | tr -d ' ')
_emit "INFO " "完成：新增 $NEW，跳过 $SKIP，失败 $FAIL，清理 $PRUNED，扫描目录 $DIRS，本次扫描文件 $TOTAL，传输 $(human "$BYTES")"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
