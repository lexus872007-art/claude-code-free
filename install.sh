#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
# Claude Code бесплатно на своём сервере - установка одной командой на Ubuntu 24.04:
#   curl -fsSL https://ty-biznesmen.ru/apps/claude-code-free/install.sh | sudo bash
# Скрипт читаемый. Версии зафиксированы. Чужие скрипты в bash не передаются.
# Безопасно запускать повторно.
set -euo pipefail

# ---- что ставим (менять только осознанно) ----
FA_VERSION="1.0.2"
NODE_VERSION="v22.23.5"   # Node 22 LTS; суммы взяты из SHASUMS256.txt, подпись которого сверена ключом релиз-команды Node.js
NODE_SHA256_X64="cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8"
NODE_SHA256_ARM64="2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09"
CLAUDE_CODE_VERSION="2.1.325"   # официальный пакет Anthropic в npm
BASE_URL="${FREE_AGENT_BASE_URL:-https://ty-biznesmen.ru/apps/claude-code-free}"                          # заменить при публикации
PACKAGE_SHA256="${FREE_AGENT_PACKAGE_SHA256:-b7aee97e798740c346990ea4142d49266969d0eebf624811707c50ee45338d62}"           # заполнить при выпуске
# Для проверки без публикации: FREE_AGENT_SRC=/путь/к/папке-репозитория
PORT="${FREE_AGENT_PORT:-8787}"

OPT=/opt/free-agent; CONF=/etc/free-agent; STATE=/var/lib/free-agent
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Нужен root. Запустите: curl -fsSL https://ty-biznesmen.ru/apps/claude-code-free/install.sh | sudo bash"
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || warn "Проверено только на Ubuntu 24.04, у вас ${PRETTY_NAME:-неизвестная система}. Продолжаю на свой риск."

case "$(uname -m)" in
  x86_64)  NODE_ARCH=x64;   NODE_SHA="$NODE_SHA256_X64" ;;
  aarch64) NODE_ARCH=arm64; NODE_SHA="$NODE_SHA256_ARM64" ;;
  *) die "Архитектура $(uname -m) не поддерживается" ;;
esac

# ---------- 1. пакеты ----------
say "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils ufw iproute2 procps >/dev/null

# ---------- 2. Node 22 (в свою папку, глобально не трогаем) ----------
say "Node.js ${NODE_VERSION}"
if [ "$(cat "$OPT/node/.version" 2>/dev/null || true)" != "$NODE_VERSION-$NODE_ARCH" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o "$tmp/node.tar.xz"
  echo "${NODE_SHA}  $tmp/node.tar.xz" | sha256sum -c - >/dev/null || die "Контрольная сумма Node не совпала - остановка"
  mkdir -p "$OPT"; rm -rf "$OPT/node"; mkdir -p "$OPT/node"
  tar -xJf "$tmp/node.tar.xz" -C "$OPT/node" --strip-components=1 --no-same-owner
  echo "$NODE_VERSION-$NODE_ARCH" > "$OPT/node/.version"
else
  echo "уже стоит"
fi
export PATH="$OPT/node/bin:$PATH"

# ---------- 3. код маршрутизатора ----------
say "Маршрутизатор"
mkdir -p "$OPT"
if [ -n "${FREE_AGENT_SRC:-}" ]; then
  [ -f "$FREE_AGENT_SRC/router/server.mjs" ] || die "В $FREE_AGENT_SRC нет router/server.mjs"
  rm -rf "$OPT/app.new"; mkdir -p "$OPT/app.new"
  cp -R --no-preserve=ownership "$FREE_AGENT_SRC/router" "$FREE_AGENT_SRC/cli" "$FREE_AGENT_SRC/catalog" "$FREE_AGENT_SRC/bin" "$FREE_AGENT_SRC/uninstall.sh" "$OPT/app.new/"
else
  tmp2="$(mktemp -d)"
  curl -fsSL "$BASE_URL/free-agent-${FA_VERSION}.tar.gz" -o "$tmp2/pkg.tar.gz"
  echo "${PACKAGE_SHA256}  $tmp2/pkg.tar.gz" | sha256sum -c - >/dev/null || die "Контрольная сумма пакета не совпала - остановка"
  rm -rf "$OPT/app.new"; mkdir -p "$OPT/app.new"
  tar -xzf "$tmp2/pkg.tar.gz" -C "$OPT/app.new" --strip-components=1 --no-same-owner; rm -rf "$tmp2"
fi
echo '{"type":"module"}' > "$OPT/app.new/package.json"
rm -rf "$OPT/app"; mv "$OPT/app.new" "$OPT/app"
chown -R root:root "$OPT"; chmod -R go-w "$OPT"
chmod +x "$OPT/app/uninstall.sh" "$OPT/app/bin/run-claude"

# ---------- 4. учётки ----------
say "Учётки"
id freeagent >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin freeagent
id aiagent   >/dev/null 2>&1 || useradd --create-home --home-dir /home/aiagent --shell /bin/bash aiagent   # без пароля
# aiagent выполняет команды за модель: прав администратора у него быть не должно
for g in sudo adm admin wheel docker lxd; do
  if id -nG aiagent | tr ' ' '\n' | grep -qx "$g"; then gpasswd -d aiagent "$g" >/dev/null 2>&1 || warn "не смог убрать aiagent из группы $g"; fi
done
getent group fatoken >/dev/null || groupadd --system fatoken
usermod -aG fatoken freeagent; usermod -aG fatoken aiagent
mkdir -p "$STATE"; chown freeagent:freeagent "$STATE"; chmod 750 "$STATE"
runuser -u aiagent -- mkdir -p /home/aiagent/work 2>/dev/null || warn "не удалось создать /home/aiagent/work"

# ---------- 5. настройки и ключи ----------
say "Настройки"
mkdir -p "$CONF"; chown root:root "$CONF"; chmod 755 "$CONF"
[ -f "$CONF/token" ] || { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CONF/token"; }
chown root:fatoken "$CONF/token"; chmod 640 "$CONF/token"   # читают только служба и aiagent
[ -f "$CONF/keys.json" ] || echo '{"providers":{}}' > "$CONF/keys.json"
chown freeagent:freeagent "$CONF/keys.json"; chmod 600 "$CONF/keys.json"
[ -f "$CONF/config.json" ] || cat > "$CONF/config.json" <<JSON
{
  "port": ${PORT},
  "first_token_timeout_s": 30,
  "stall_timeout_s": 60
}
JSON

# ---------- 6. Claude Code (официальный пакет Anthropic из npm, версия зафиксирована) ----------
if [ -z "${FREE_AGENT_SKIP_CLAUDE:-}" ]; then
  say "Claude Code ${CLAUDE_CODE_VERSION}"
  if [ "$("$OPT/claude/bin/claude" --version 2>/dev/null | awk '{print $1}')" != "$CLAUDE_CODE_VERSION" ]; then
    mkdir -p "$OPT/claude"
    "$OPT/node/bin/npm" install -g --prefix "$OPT/claude" --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" >/dev/null
    chown -R root:root "$OPT/claude"; chmod -R go-w "$OPT/claude"
  else
    echo "уже стоит"
  fi
fi

# ---------- 7. команды ----------
say "Команды agent, agent-setup, agent-stats"
cat > /usr/local/bin/agent <<'SH'
#!/usr/bin/env bash
# Запуск Claude Code на бесплатных моделях. Всегда под учёткой aiagent (без прав администратора).
set -euo pipefail
OPT=/opt/free-agent
# не от root: просим sudo (учётка aiagent переключается только из-под root)
[ "$(id -u)" = 0 ] || exec sudo /usr/local/bin/agent "$@"
PORT="$("$OPT/node/bin/node" -e 'try{console.log(JSON.parse(require("fs").readFileSync("/etc/free-agent/config.json","utf8")).port||8787)}catch{console.log(8787)}')"
H="$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true)"
[ -n "$H" ] || { echo "Маршрутизатор не отвечает. Проверьте: systemctl status free-agent" >&2; exit 1; }
echo "$H" | grep -q '"providers":\[\]' && { echo "Не введено ни одного ключа. Запустите: sudo agent-setup" >&2; exit 1; }
# чистое окружение: переменные root (пароли, ключи) модели не передаём; --pty отделяет терминал от root-сессии
exec runuser --pty -u aiagent -- env -i HOME=/home/aiagent USER=aiagent LOGNAME=aiagent SHELL=/bin/bash \
  TERM="${TERM:-xterm}" LANG="${LANG:-C.UTF-8}" COLORTERM="${COLORTERM:-}" "$OPT/app/bin/run-claude" "$@"
SH
cat > /usr/local/bin/agent-setup <<SH
#!/usr/bin/env bash
exec $OPT/node/bin/node $OPT/app/cli/setup.mjs "\$@"
SH
cat > /usr/local/bin/agent-stats <<SH
#!/usr/bin/env bash
exec $OPT/node/bin/node $OPT/app/cli/stats.mjs "\$@"
SH
cat > /usr/local/bin/agent-uninstall <<SH
#!/usr/bin/env bash
exec bash $OPT/app/uninstall.sh "\$@"
SH
chmod 755 /usr/local/bin/agent /usr/local/bin/agent-setup /usr/local/bin/agent-stats /usr/local/bin/agent-uninstall

# Настройки Claude Code пишем ОТ ИМЕНИ aiagent: если он подложил в свою папку символьные ссылки, root по ним не пойдёт
runuser -u aiagent -- env HOME=/home/aiagent "$OPT/node/bin/node" - <<'JS' || warn "Настройки Claude Code в /home/aiagent не записались (проверьте, нет ли там чужих ссылок вместо файлов)"
const fs=require('fs');
const home='/home/aiagent';
const rj=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const cj=rj(home+'/.claude.json',{}); cj.hasCompletedOnboarding=true; cj.theme=cj.theme||'dark';
fs.writeFileSync(home+'/.claude.json',JSON.stringify(cj,null,2));
fs.mkdirSync(home+'/.claude',{recursive:true});
const sj=rj(home+'/.claude/settings.json',{});
sj.env={...(sj.env||{}),DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
fs.writeFileSync(home+'/.claude/settings.json',JSON.stringify(sj,null,2));
JS

# ---------- 8. служба ----------
say "Служба systemd"
cat > /etc/systemd/system/free-agent.service <<UNIT
[Unit]
Description=Free Agent router (localhost only)
After=network-online.target
Wants=network-online.target

[Service]
User=freeagent
Group=freeagent
ExecStart=$OPT/node/bin/node $OPT/app/router/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$STATE
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable free-agent >/dev/null 2>&1
  systemctl restart free-agent
  sleep 1
  systemctl is-active --quiet free-agent && echo "служба запущена" || { warn "служба не запустилась: journalctl -u free-agent -n 30"; }
else
  warn "systemd не запущен (похоже на контейнер). Службу не стартую; вручную: sudo -u freeagent $OPT/node/bin/node $OPT/app/router/server.mjs"
fi

# ---------- 9. защита сервера ----------
say "Файрвол (ufw): входящее закрыто, кроме SSH"
# порты SSH: из настроек sshd, из сокета ssh.socket (по умолчанию в Ubuntu 24.04), из слушающих и текущих соединений
detect_ssh_ports() {
  {
    sshd -T 2>/dev/null | awk '$1=="port"{print $2}'
    systemctl is-active --quiet ssh.socket 2>/dev/null && systemctl show ssh.socket -p Listen 2>/dev/null | sed -n 's/^Listen=.*:\([0-9][0-9]*\) (Stream).*/\1/p'
    ss -H -tlnp 2>/dev/null | awk '/"sshd"|ssh\.socket/{n=split($4,a,":"); print a[n]}'
    ss -H -tnp state established 2>/dev/null | awk '/"sshd"/{ep=$3; if (ep ~ /^127\./ || ep ~ /^\[?::1\]?:/) next; n=split(ep,a,":"); print a[n]}'
    [ -n "${FREE_AGENT_SSH_PORT:-}" ] && echo "$FREE_AGENT_SSH_PORT"
  } | grep -E '^[0-9]+$' | sort -un | tr '\n' ' '
}
SSH_PORTS="$(detect_ssh_ports || true)"
# чужие службы, слушающие снаружи (сайт, VPN, почта): ufw закрыл бы их молча
OTHER="$(ss -H -tuln 2>/dev/null | awk '{ep=$5; if (ep ~ /^127\./ || ep ~ /^\[?::1\]?:/ || ep ~ /%lo:/) next; n=split(ep,a,":"); print $1" "a[n]}' | sort -u | while read -r proto port; do
  case "$proto/$port" in udp/68|udp/546|udp/5353) continue ;; esac
  case " $SSH_PORTS " in *" $port "*) continue ;; esac
  echo "$proto/$port"
done | tr '\n' ' ')"
UFW_ACTIVE=no; ufw status 2>/dev/null | grep -q '^Status: active' && UFW_ACTIVE=yes

if [ -z "$SSH_PORTS" ]; then
  warn "Порт SSH определить не удалось, поэтому файрвол НЕ включаю: иначе можно потерять доступ к серверу. Узнайте порт SSH и выполните: sudo ufw default deny incoming && sudo ufw allow <порт>/tcp && sudo ufw --force enable. Или запустите установку ещё раз: curl -fsSL https://ty-biznesmen.ru/apps/claude-code-free/install.sh | sudo FREE_AGENT_SSH_PORT=<порт> bash"
elif [ "$UFW_ACTIVE" = yes ]; then
  for p in $SSH_PORTS; do ufw allow "${p}/tcp" >/dev/null; done
  warn "ufw уже включён - правила не менял, только убедился, что SSH (порты: $SSH_PORTS) разрешён."
elif [ -n "$OTHER" ] && [ "${FREE_AGENT_UFW:-}" != force ]; then
  warn "На сервере уже слушают снаружи другие службы: $OTHER. Если включить файрвол, они перестанут быть доступны, поэтому я его НЕ включаю. Откройте нужные порты (например sudo ufw allow 443/tcp) и включите сами: sudo ufw default deny incoming && sudo ufw allow ${SSH_PORTS%% *}/tcp && sudo ufw --force enable. Либо перезапустите установку: curl -fsSL https://ty-biznesmen.ru/apps/claude-code-free/install.sh | sudo FREE_AGENT_UFW=force bash - тогда закрою всё, кроме SSH."
else
  ufw default deny incoming >/dev/null 2>&1 && ufw default allow outgoing >/dev/null 2>&1 || warn "ufw не настроился (контейнер без прав на netfilter?)"
  for p in $SSH_PORTS; do ufw allow "${p}/tcp" >/dev/null; echo "SSH порт $p разрешён"; done
  ufw --force enable >/dev/null 2>&1 && echo "ufw включён" || warn "ufw не включился (контейнер без прав на netfilter?)"
fi
echo "Маршрутизатор слушает только 127.0.0.1:${PORT} - снаружи он недоступен независимо от файрвола."

if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
  warn "Вход на сервер сейчас разрешён по паролю. Надёжнее вход по SSH-ключу: обычно его добавляют в панели хостинга. Я это не меняю, чтобы случайно не закрыть вам доступ."
fi

say "Готово"
cat <<MSG
Дальше:
  1) sudo agent-setup     - ввести ключи бесплатных провайдеров (мастер подскажет, где их взять; ключ вставьте и нажмите Enter)
  2) agent                - запустить Claude Code
  3) agent-stats          - статистика по провайдерам за сутки
Важно: это НЕ модели Claude, а открытые модели бесплатных провайдеров. Запросы уходят им.
MSG
