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
npx tsc --outDir dist --rootDir .

# ---- Reiniciar servidor via PM2 ----
echo ""
echo ">>> Reiniciando servidor..."
pm2 restart "$APP_NAME"

echo ""
echo "============================================"
echo "  Atualização concluída!"
echo "============================================"
echo ""
echo "  Verificar status: pm2 status"
echo "  Ver logs: pm2 logs ${APP_NAME}"
echo ""
