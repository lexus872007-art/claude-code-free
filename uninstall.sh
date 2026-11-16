#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 Алексей Гаврилов (Aleksei Gavrilov)
# Удаление. Ключи удаляются тоже. Файрвол остаётся включённым (это безопасно).
# Весь скрипт в функции: bash прочитает его целиком до удаления своей папки, копий в /tmp нет.
main() {
  set -u
  [ "$(id -u)" = 0 ] || { echo "Нужен root: sudo agent-uninstall"; return 1; }
  if [ "${1:-}" != "--yes" ]; then
    read -r -p "Удалить службу, программы, ключи и учётки freeagent/aiagent (папка /home/aiagent тоже)? Введите 'да': " a
    [ "$a" = да ] || { echo "Отменено."; return 0; }
  fi
  systemctl disable --now free-agent 2>/dev/null
  rm -f /etc/systemd/system/free-agent.service; systemctl daemon-reload 2>/dev/null
  rm -f /usr/local/bin/agent /usr/local/bin/agent-setup /usr/local/bin/agent-stats /usr/local/bin/agent-uninstall
  # процессы агента (в том числе то, что Claude Code запустил) - иначе userdel откажет
  pkill -KILL -u aiagent 2>/dev/null; pkill -KILL -u freeagent 2>/dev/null
  for _ in 1 2 3 4 5; do pgrep -u aiagent >/dev/null 2>&1 || pgrep -u freeagent >/dev/null 2>&1 || break; sleep 1; done
  rm -rf /etc/free-agent /var/lib/free-agent /opt/free-agent
  # перед удалением учётки: расписание cron и временные файлы aiagent (иначе остаются бесхозными)
  crontab -r -u aiagent 2>/dev/null
  find /tmp /var/tmp /dev/shm -xdev -user aiagent -delete 2>/dev/null
  local bad=""
  id freeagent >/dev/null 2>&1 && { userdel freeagent 2>/dev/null || bad="$bad freeagent"; }
  id aiagent   >/dev/null 2>&1 && { userdel -r aiagent 2>/dev/null || bad="$bad aiagent"; }
  getent group fatoken >/dev/null 2>&1 && groupdel fatoken 2>/dev/null
  if [ -n "$bad" ]; then
    echo "Не удалось удалить учётки:$bad. Завершите их процессы и выполните: sudo userdel -r <имя>"; return 1
  fi
  echo "Удалено. Файрвол ufw оставлен включённым (SSH открыт). Отключить: sudo ufw disable"
}
main "$@"
exit $?
