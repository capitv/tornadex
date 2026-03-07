#!/usr/bin/env bash
# ============================================================
# update.sh — Script rápido de atualização do Tornadex
# Puxa código novo, rebuilda e reinicia o servidor.
#
# Uso: sudo bash /opt/tornadex/update.sh
# ============================================================

set -euo pipefail

APP_NAME="tornadex"
APP_DIR="/opt/tornadex"

echo "============================================"
echo "  Atualizando Tornadex..."
echo "============================================"

cd "$APP_DIR"

# ---- Puxar código novo ----
echo ""
echo ">>> Puxando alterações do Git..."
git pull

# ---- Instalar dependências (caso tenha mudado) ----
echo ""
echo ">>> Instalando dependências..."
npm install

# ---- Rebuildar client e server ----
echo ""
echo ">>> Buildando client (vite)..."
npx vite build

echo ""
echo ">>> Buildando server (tsc)..."
npx tsc -p tsconfig.server.json

# ---- Reiniciar servidor via PM2 ----
echo ""
echo ">>> Parando servidor..."
pm2 stop "$APP_NAME" 2>/dev/null || true
pm2 delete "$APP_NAME" 2>/dev/null || true
# Kill any process still holding port 3001
fuser -k 3001/tcp 2>/dev/null || true
sleep 2
echo ">>> Iniciando servidor..."
pm2 start server/index.ts --name "$APP_NAME" --interpreter node --node-args="--import tsx/esm"

echo ""
echo "============================================"
echo "  Atualização concluída!"
echo "============================================"
echo ""
echo "  Verificar status: pm2 status"
echo "  Ver logs: pm2 logs ${APP_NAME}"
echo ""
