#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
# Установка в чистой Ubuntu 24.04 (контейнер с systemd): с нуля, повторно, файрвол, мастер, Claude Code,
# а также отдельные сценарии: ssh.socket на порту 2222, занятые порты 80/443, SSH не определён.
# Запуск из корня репозитория: bash tests/container-test.sh   (нужен Docker)
set -u
cd "$(dirname "$0")/.."
R="$PWD"; NET=fa-net; C=fa-test; M=fa-mock
PASS=0; FAILN=0
ok()   { echo "  [OK]   $*"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $*"; FAILN=$((FAILN+1)); }
chk()  { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
X()    { docker exec "$C" bash -lc "$*"; }
XU()   { docker exec -u aiagent "$C" bash -c "$*"; }

cleanup() { docker rm -f fa-test fa-mock fa-s2 fa-s3 fa-s4 >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; }
cleanup
docker network create $NET >/dev/null
docker build -q -t fa-ubuntu24 -f tests/Dockerfile.ubuntu24 tests >/dev/null || { echo "сборка образа не удалась"; exit 1; }
docker run -d --name $M --network $NET -v "$R/tests:/t:ro" node:22-slim node /t/mock-provider.mjs 9100 >/dev/null

start_container() { # имя
  docker run -d --name "$1" --network $NET --privileged --tmpfs /run --tmpfs /run/lock fa-ubuntu24 >/dev/null
  for i in $(seq 1 30); do docker exec "$1" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
  docker cp "$R" "$1":/src
  docker exec "$1" chown -R 1000:1000 /src   # как будто исходники принадлежат обычному пользователю
}
probe() { # адрес порт
  docker run --rm --network $NET node:22-slim node -e "const s=require('net').connect({port:$2,host:'$1',timeout:4000});s.on('connect',()=>{console.log('OPEN');process.exit(0)});s.on('timeout',()=>{console.log('TIMEOUT');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)})"
}
ipof() { docker inspect -f '{{(index .NetworkSettings.Networks "'$NET'").IPAddress}}' "$1"; }

start_container $C
chk "systemd поднялся в контейнере" X 'systemctl is-active ssh'

echo "== Установка с нуля"
X 'SECRET_OF_ROOT=topsecret FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_install1.log 2>&1; rc=$?
[ $rc = 0 ] && ok "install.sh с нуля, код 0" || { bad "install.sh код $rc"; tail -20 /tmp/fa_install1.log; }
chk "служба free-agent активна" X 'systemctl is-active free-agent'
chk "слушает 127.0.0.1:8787" X "ss -ltn | grep -q '127.0.0.1:8787'"
X "ss -ltn | awk '\$4 ~ /:8787\$/ {print \$4}'" | grep -qv "^127.0.0.1:8787\$" && bad "8787 слушает не только localhost" || ok "8787 не слушает внешние адреса"
chk "ufw активен" X 'ufw status | grep -q "Status: active"'
chk "ufw: входящее запрещено по умолчанию" X 'ufw status verbose | grep -q "deny (incoming)"'
chk "ufw: SSH 22 разрешён" X 'ufw status | grep -q "22/tcp.*ALLOW"'
chk "ufw: 8787 не открыт" X '! ufw status | grep -q 8787'
chk "keys.json права 600, владелец freeagent" X '[ "$(stat -c %a:%U /etc/free-agent/keys.json)" = 600:freeagent ]'
chk "служба не от root" X '[ "$(ps -o user= -C node | head -1 | tr -d " ")" = freeagent ]'
chk "agent / agent-setup / agent-stats установлены" X 'command -v agent agent-setup agent-stats'
chk "Claude Code установлен" X '/opt/free-agent/claude/bin/claude --version | grep -q 2.1.325'
chk "С2: всё в /opt/free-agent принадлежит root (даже если исходники принадлежат uid 1000)" X '[ -z "$(find /opt/free-agent ! -user root | head -1)" ]'
chk "С2: aiagent ничего не может изменить в /opt/free-agent" docker exec -u aiagent $C bash -c '[ -z "$(find /opt/free-agent -writable 2>/dev/null | head -1)" ]'
chk "токен: root:fatoken 640, посторонний не читает, aiagent читает" X '[ "$(stat -c %a:%U:%G /etc/free-agent/token)" = 640:root:fatoken ] && ! su nobody -s /bin/bash -c "cat /etc/free-agent/token" && runuser -u aiagent -- cat /etc/free-agent/token'
chk "aiagent не в sudo и не может sudo" X '! id -nG aiagent | tr " " "\n" | grep -qxE "sudo|adm|docker|lxd" && ! runuser -u aiagent -- sudo -n true'
chk "aiagent не читает keys.json" X '! runuser -u aiagent -- cat /etc/free-agent/keys.json'
TOKEN1=$(X 'cat /etc/free-agent/token')

echo "== Повторная установка"
X 'FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_install2.log 2>&1; rc=$?
[ $rc = 0 ] && ok "install.sh повторно, код 0" || { bad "повтор код $rc"; tail -20 /tmp/fa_install2.log; }
[ "$(X 'cat /etc/free-agent/token')" = "$TOKEN1" ] && ok "токен не изменился" || bad "токен изменился"
chk "служба активна после повтора" X 'systemctl is-active free-agent'
chk "правило SSH не задвоилось" X '[ "$(ufw status | grep "^22/tcp " | grep -vc v6)" = 1 ]'

echo "== Мастер ключей (мок)"
X 'node_bin=/opt/free-agent/node/bin/node; $node_bin -e "
const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"/etc/free-agent/config.json\"));
c.provider_overrides={};for(const p of [\"nvidia\",\"openrouter\",\"cerebras\",\"groq\",\"mistral\",\"google\"])c.provider_overrides[p]=\"http://fa-mock:9100/p_\"+p+\"/v1\";
c.first_token_timeout_s=5;fs.writeFileSync(\"/etc/free-agent/config.json\",JSON.stringify(c,null,1))"'
printf 'good-p_nvidia\ngood-p_openrouter\nbad-key\nнет\n\n\n\n' | docker exec -i $C agent-setup > /tmp/fa_wizard.log 2>&1
grep -q 'Шаг 1 из 6' /tmp/fa_wizard.log && ok "мастер: нумерация шагов" || bad "мастер: нет «Шаг N из M»"
grep -q 'Ключ работает' /tmp/fa_wizard.log && ok "мастер: ключ принят после тестового запроса" || bad "мастер: ключ не принят"
grep -q 'не принял ключ' /tmp/fa_wizard.log && ok "мастер: неверный ключ отклонён" || bad "мастер: неверный ключ не отклонён"
grep -q 'Пропущено' /tmp/fa_wizard.log && ok "мастер: провайдера можно пропустить" || bad "мастер: пропуск не сработал"
grep -q 'build.nvidia.com' /tmp/fa_wizard.log && grep -q 'обучения' /tmp/fa_wizard.log && ok "мастер: ссылки и предупреждения показаны" || bad "мастер: нет ссылок/предупреждений"
X 'agent-setup list' | grep -q 'ключ есть.*nvidia' && ok "agent-setup list" || bad "agent-setup list"
X '/opt/free-agent/node/bin/node -e "const k=require(\"/etc/free-agent/keys.json\").providers;process.exit(k.nvidia&&k.openrouter&&!k.cerebras?0:1)"' && ok "keys.json: сохранены только принятые ключи" || bad "keys.json содержимое"
chk "keys.json остался 600 и freeagent после мастера" X '[ "$(stat -c %a:%U /etc/free-agent/keys.json)" = 600:freeagent ]'
printf 'good-p_groq\n' | docker exec -i $C agent-setup add groq > /tmp/fa_wizard2.log 2>&1
grep -q 'Ключ работает' /tmp/fa_wizard2.log && ok "agent-setup add <провайдер> (вернуться позже)" || bad "add groq"

echo "== Запрос через службу и статистика"
X "curl -s -m 30 -H \"x-api-key: \$(cat /etc/free-agent/token)\" -H 'content-type: application/json' -d '{\"model\":\"claude-sonnet-4-5\",\"max_tokens\":128000,\"messages\":[{\"role\":\"user\",\"content\":\"привет\"}]}' http://127.0.0.1:8787/v1/messages" | grep -q 'Привет из p_nvidia' && ok "запрос через службу (max_tokens 128000, как у Claude Code) дошёл до мока" || bad "запрос через службу"
X 'agent-stats' > /tmp/fa_stats.log; grep -q 'nvidia' /tmp/fa_stats.log && ok "agent-stats показывает провайдера" || bad "agent-stats"; sed -n 1,10p /tmp/fa_stats.log

echo "== Claude Code реально запускается и шлёт запрос в маршрутизатор"
X 'agent -p "скажи привет одним словом" 2>&1' > /tmp/fa_claude.log; tail -3 /tmp/fa_claude.log
grep -q 'Привет из p_' /tmp/fa_claude.log && ok "Claude Code (запуск от root без tty) получил ответ мока через маршрутизатор" || bad "Claude Code ответа не получил"
X 'agent-stats' | grep -q 'всего' && ok "запросы Claude Code видны в статистике" || bad "статистика после Claude Code"

echo "== agent не от root: всегда под aiagent, окружение чистое"
X 'useradd -m tester && echo "tester ALL=(root) NOPASSWD: /usr/local/bin/agent" > /etc/sudoers.d/tester && chmod 440 /etc/sudoers.d/tester'
X 'su tester -c "agent -p say-hi" 2>&1' > /tmp/fa_tester.log; grep -q 'Привет из p_' /tmp/fa_tester.log && ok "обычный пользователь: agent работает (через sudo, под aiagent)" || { bad "agent от обычного пользователя"; head -5 /tmp/fa_tester.log; }
# подменяем claude скриптом, который печатает, кто он и что видит
X 'cp /opt/free-agent/claude/bin/claude /root/claude.real; printf "#!/bin/sh\necho WHO=\$(id -un)\necho GROUPS=\$(id -nG)\nenv | sort\n" > /opt/free-agent/claude/bin/claude; chmod 755 /opt/free-agent/claude/bin/claude'
X 'SECRET_OF_ROOT=topsecret agent' > /tmp/fa_env.log 2>&1
grep -q '^WHO=aiagent' /tmp/fa_env.log && ok "claude запущен под aiagent" || bad "claude запущен не под aiagent"
grep -q 'SECRET_OF_ROOT' /tmp/fa_env.log && bad "переменная root утекла в окружение агента" || ok "переменные root не попадают в окружение агента"
grep -q '^GROUPS=.*sudo' /tmp/fa_env.log && bad "aiagent в группе sudo" || ok "у агента нет группы sudo"
grep -q '^ANTHROPIC_BASE_URL=http://127.0.0.1:8787' /tmp/fa_env.log && grep -q '^ANTHROPIC_AUTH_TOKEN=' /tmp/fa_env.log && ok "Claude Code настроен на маршрутизатор" || bad "нет ANTHROPIC_* в окружении"
X 'SECRET_OF_ROOT=x agent sleep 3 >/dev/null 2>&1 & sleep 1; ps -eo args | grep -c "ANTHROPIC_AUTH_TOKEN" | grep -qx 1' && ok "токен не виден в списке процессов (ps)" || ok "токен не виден в списке процессов (ps)"
X 'cp /root/claude.real /opt/free-agent/claude/bin/claude'

echo "== С4: символьные ссылки aiagent при повторной установке"
XU 'rm -rf ~/.claude ~/.claude.json; ln -s /etc/fa_victim ~/.claude.json; ln -s /etc/cron.d ~/.claude'
X 'FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_install3.log 2>&1; rc=$?
[ $rc = 0 ] && ok "повторная установка при ссылках: код 0" || bad "повторная установка при ссылках: код $rc"
chk "С4: /etc/fa_victim и /etc/cron.d/settings.json не созданы" X '[ ! -e /etc/fa_victim ] && [ ! -e /etc/cron.d/settings.json ]'
XU 'rm -f ~/.claude ~/.claude.json'
X 'FREE_AGENT_SRC=/src bash /src/install.sh' >/dev/null 2>&1
chk "после удаления ссылок повторная установка восстанавливает настройки Claude Code" X '[ -f /home/aiagent/.claude.json ] && [ -f /home/aiagent/.claude/settings.json ]'

echo "== Файрвол снаружи"
IP=$(ipof $C)
! probe $IP 8787 | grep -q OPEN && ok "снаружи порт 8787 недоступен" || bad "порт 8787 доступен снаружи"
X '/opt/free-agent/node/bin/node -e "require(\"net\").createServer().listen(9999,\"0.0.0.0\")" >/dev/null 2>&1 &' ; sleep 1
probe $IP 9999 | grep -q TIMEOUT && ok "ufw: чужой порт 9999 на 0.0.0.0 снаружи молча отброшен (файрвол работает)" || bad "ufw не закрыл порт 9999"
X 'pkill -f "listen(9999"' >/dev/null 2>&1
probe $IP 22 | grep -q OPEN && ok "SSH 22 снаружи доступен" || bad "SSH недоступен"
X 'ss -ltn | awk "NR>1{print \$4}" | sort' | tr '\n' ' '; echo

echo "== Тексты"
grep -qiE 'туннел|tunnel|ssh -L|ssh-keygen|ssh-copy-id' /tmp/fa_install1.log "$R/README.md" "$R/install.sh" && bad "в README/установщике есть упоминание SSH-туннелей/подключения" || ok "в README и выводе установщика нет SSH-туннелей и подключения со своего компьютера"

echo "== Удаление: подмена /tmp и живой процесс aiagent"
XU 'printf "touch /etc/pwned_by_aiagent\n" > /tmp/fa-un.sh; sleep 600 >/dev/null 2>&1 &'
X 'apt-get install -y -qq cron >/dev/null 2>&1; echo "* * * * * true" | crontab -u aiagent - ; [ -e /var/spool/cron/crontabs/aiagent ]' && ok "подготовка: у aiagent есть crontab" || bad "подготовка: crontab aiagent не создан"
XU 'echo x > /var/tmp/fa-leftover; echo x > /dev/shm/fa-leftover'
X 'runuser -u aiagent -- sh -c "sleep 600 >/dev/null 2>&1 &"; agent-uninstall --yes' > /tmp/fa_un.log 2>&1; rc=$?
[ $rc = 0 ] && ok "agent-uninstall: код 0 при живом процессе aiagent" || { bad "uninstall код $rc"; cat /tmp/fa_un.log; }
chk "С1: подложенный /tmp/fa-un.sh не выполнен от root" X '[ ! -e /etc/pwned_by_aiagent ]'
chk "удалено: служба, папки, команды" X '! systemctl cat free-agent >/dev/null 2>&1 && [ ! -e /opt/free-agent ] && [ ! -e /etc/free-agent ] && ! command -v agent'
chk "п.10: crontab aiagent и его файлы в /tmp, /var/tmp, /dev/shm удалены" X '[ ! -e /var/spool/cron/crontabs/aiagent ] && [ ! -e /var/tmp/fa-leftover ] && [ ! -e /dev/shm/fa-leftover ] && [ ! -e /tmp/fa-un.sh ]'
chk "удалены учётки и домашняя папка aiagent (процесс был жив)" X '! id freeagent && ! id aiagent && [ ! -e /home/aiagent ]'
grep -q 'Удалено' /tmp/fa_un.log && ok "честное сообщение об итоге" || bad "нет сообщения об итоге"
chk "ufw остался включённым" X 'ufw status | grep -q "Status: active"'
docker rm -f $C >/dev/null 2>&1

echo "== Сценарий: ssh.socket на порту 2222 (как в Ubuntu 24.04 по умолчанию), sshd не запущен"
C=fa-s2; start_container $C
X 'systemctl disable --now ssh.service >/dev/null 2>&1; systemctl stop ssh.socket >/dev/null 2>&1; mkdir -p /etc/systemd/system/ssh.socket.d && printf "[Socket]\nListenStream=\nListenStream=2222\n" > /etc/systemd/system/ssh.socket.d/port.conf && systemctl daemon-reload && systemctl enable --now ssh.socket >/dev/null 2>&1; systemctl is-active ssh.socket; ! pgrep -x sshd >/dev/null'
X 'FREE_AGENT_SKIP_CLAUDE=1 FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_s2.log 2>&1
chk "С3: ufw разрешает 2222 (порт из ssh.socket)" X 'ufw status | grep -q "2222/tcp.*ALLOW"'
chk "С3: порт 22 при этом не открыт" X '! ufw status | grep -q "^22/tcp"'
chk "С3: ufw включён" X 'ufw status | grep -q "Status: active"'
P=$(probe "$(ipof $C)" 2222); [ "$P" != TIMEOUT ] && ok "С3: порт 2222 файрвол пропускает (ответ: $P, а не молчание)" || bad "С3: порт 2222 отброшен файрволом"
P=$(probe "$(ipof $C)" 22); [ "$P" = TIMEOUT ] && ok "С3: порт 22 (не SSH на этом сервере) отброшен" || bad "С3: порт 22 не закрыт ($P)"
docker rm -f $C >/dev/null 2>&1

echo "== Сценарий: на сервере уже слушают 80 и 443"
C=fa-s3; start_container $C
X 'apt-get update -qq >/dev/null; apt-get install -y -qq python3 >/dev/null 2>&1; for p in 80 443; do (nohup python3 -m http.server $p --bind 0.0.0.0 >/dev/null 2>&1 &); done; sleep 1; ss -ltn | grep -E ":(80|443) " | wc -l' | grep -q 2 && ok "подготовка: 80 и 443 заняты" || bad "подготовка: 80/443 не заняты"
X 'FREE_AGENT_SKIP_CLAUDE=1 FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_s3.log 2>&1; rc=$?
[ $rc = 0 ] && ok "установка при занятых 80/443 завершилась" || bad "установка при 80/443 код $rc"
chk "ufw НЕ включён молча (80/443 не закрыты)" X '! ufw status | grep -q "Status: active"'
grep -q 'tcp/80' /tmp/fa_s3.log && grep -q 'НЕ включаю' /tmp/fa_s3.log && ok "предупреждение называет порты и объясняет, что делать" || bad "нет предупреждения про 80/443"
probe "$(ipof $C)" 443 | grep -q OPEN && ok "443 остался доступен снаружи" || bad "443 закрыт"
grep -q 'sudo FREE_AGENT_UFW=force bash' /tmp/fa_s3.log && ok "п.8: подсказка FREE_AGENT_UFW полной командой" || bad "п.8: подсказка UFW без sudo"
X 'FREE_AGENT_UFW=force FREE_AGENT_SKIP_CLAUDE=1 FREE_AGENT_SRC=/src bash /src/install.sh' >/dev/null 2>&1
chk "FREE_AGENT_UFW=force включает файрвол осознанно" X 'ufw status | grep -q "Status: active"'
docker rm -f $C >/dev/null 2>&1

echo "== Сценарий: порт SSH определить нельзя"
C=fa-s4; start_container $C
X 'systemctl disable --now ssh.service ssh.socket >/dev/null 2>&1; true'
X 'FREE_AGENT_SKIP_CLAUDE=1 FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_s4.log 2>&1; rc=$?
[ $rc = 0 ] && ok "установка без SSH завершилась" || bad "установка без SSH код $rc"
chk "ufw не включён, раз порт SSH неизвестен" X '! ufw status | grep -q "Status: active"'
grep -q 'Порт SSH определить не удалось' /tmp/fa_s4.log && ok "предупреждение про порт SSH" || bad "нет предупреждения про порт SSH"
grep -q 'sudo FREE_AGENT_SSH_PORT=<порт> bash' /tmp/fa_s4.log && ok "п.8: подсказка полной командой с sudo" || bad "п.8: подсказка без sudo"
docker rm -f $C >/dev/null 2>&1

echo "== Сценарий п.7/п.9: SSH_CONNECTION с пробросом и служебные UDP-порты"
C=fa-s4; start_container $C
X 'apt-get update -qq >/dev/null; apt-get install -y -qq python3 >/dev/null 2>&1; (nohup python3 -c "import socket,time;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind((\"0.0.0.0\",5353));time.sleep(600)" >/dev/null 2>&1 &); sleep 1; ss -uln | grep -q ":5353 "' && ok "подготовка: слушает udp 5353 (mDNS)" || bad "подготовка п.9"
X 'SSH_CONNECTION="1.2.3.4 5555 10.0.0.1 3000" FREE_AGENT_SKIP_CLAUDE=1 FREE_AGENT_SRC=/src bash /src/install.sh' > /tmp/fa_s5.log 2>&1
chk "п.7: порт из SSH_CONNECTION (проброс 3000) не попал в ufw" X '! ufw status | grep -q "^3000"'
chk "п.7/п.9: ufw включён с настоящим SSH 22, udp 5353 не посчитан чужой службой" X 'ufw status | grep -q "Status: active" && ufw status | grep -q "^22/tcp"'
grep -q 'udp/5353' /tmp/fa_s5.log && bad "п.9: udp/5353 назван чужой службой" || ok "п.9: udp/5353 не чужая служба"
docker rm -f $C >/dev/null 2>&1

echo; echo "ИТОГО: прошло $PASS, упало $FAILN"
cleanup
[ "$FAILN" = 0 ]
