#!/usr/bin/env bash
# ============================================================
# deploy.sh — Script de deploy completo para o Tornadex
# Roda no VPS Ubuntu 24.04 (Hetzner) e faz TUDO:
#   - Instala Node.js 20, nginx, pm2
#   - Clona o repositório (ou atualiza se já existe)
#   - Builda client + server
#   - Configura PM2 e nginx
#   - Abre portas no firewall
#
# Uso: curl -sL <url>/deploy.sh | sudo bash
#   ou: sudo bash deploy.sh
#
# Pode rodar múltiplas vezes (idempotente).
# ============================================================

set -euo pipefail

# ---- Variáveis ----
APP_NAME="tornadex"
APP_DIR="/opt/tornadex"
REPO_URL="https://github.com/capitv/tornadex.git"
NODE_VERSION="20"
SERVER_PORT=3001

echo "============================================"
echo "  Deploy do Tornadex — Início"
echo "============================================"

# ---- Verificar se roda como root ----
if [ "$EUID" -ne 0 ]; then
    echo "ERRO: Execute como root (sudo bash deploy.sh)"
    exit 1
fi

# ============================================================
# 1. Instalar Node.js 20 LTS (via NodeSource)
# ============================================================
echo ""
echo ">>> [1/7] Instalando Node.js ${NODE_VERSION}..."

if command -v node &>/dev/null && node -v | grep -q "v${NODE_VERSION}"; then
    echo "    Node.js $(node -v) já instalado. Pulando."
else
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    # Adiciona repositório NodeSource
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
    echo "    Node.js $(node -v) instalado com sucesso."
fi

# ============================================================
# 2. Instalar nginx
# ============================================================
echo ""
echo ">>> [2/7] Instalando nginx..."

if command -v nginx &>/dev/null; then
    echo "    nginx já instalado. Pulando."
else
    apt-get install -y -qq nginx
    echo "    nginx instalado."
fi

# ============================================================
# 3. Instalar PM2 globalmente
# ============================================================
echo ""
echo ">>> [3/7] Instalando PM2..."

if command -v pm2 &>/dev/null; then
    echo "    PM2 já instalado. Pulando."
else
    npm install -g pm2
    echo "    PM2 instalado."
fi

# ============================================================
# 4. Clonar ou atualizar o repositório
# ============================================================
echo ""
echo ">>> [4/7] Preparando código em ${APP_DIR}..."

if [ -d "${APP_DIR}/.git" ]; then
    echo "    Repositório já existe. Atualizando com git pull..."
    cd "$APP_DIR"
    git pull
else
    echo "    Clonando repositório..."
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# ============================================================
# 5. Instalar dependências e buildar
# ============================================================
echo ""
echo ">>> [5/7] Instalando dependências e buildando..."

cd "$APP_DIR"

# Instalar dependências (incluindo devDependencies para o build)
npm install

# Buildar o client (Vite → dist/client/)
echo "    Buildando client (vite build)..."
npx vite build

# Buildar o server (TypeScript → dist/server/)
echo "    Buildando server (tsc)..."
npx tsc -p tsconfig.server.json

echo "    Build completo."

# ============================================================
# 6. Configurar PM2
# ============================================================
echo ""
echo ">>> [6/7] Configurando PM2..."

cd "$APP_DIR"

# Parar processo antigo se existir (ignora erro se não existe)
pm2 delete "$APP_NAME" 2>/dev/null || true

# Iniciar servidor Node.js com PM2
pm2 start dist/server/index.js \
    --name "$APP_NAME" \
    --node-args="--experimental-specifier-resolution=node" \
    --env production \
    --max-memory-restart 1500M

# Salvar lista de processos para restart automático
pm2 save

# Configurar PM2 para iniciar no boot do sistema
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo "    PM2 configurado. Servidor rodando na porta ${SERVER_PORT}."

# ============================================================
# 7. Configurar nginx
# ============================================================
echo ""
echo ">>> [7/7] Configurando nginx..."

# Copiar config do nginx
cp "${APP_DIR}/nginx.conf" /etc/nginx/sites-available/tornadex

# Ativar o site (link simbólico)
ln -sf /etc/nginx/sites-available/tornadex /etc/nginx/sites-enabled/tornadex

# Remover config padrão do nginx (se existir)
rm -f /etc/nginx/sites-enabled/default

# Testar configuração
nginx -t

# Recarregar nginx
systemctl enable nginx
systemctl restart nginx

echo "    nginx configurado e rodando."

# ============================================================
# 8. Firewall (ufw)
# ============================================================
echo ""
echo ">>> Configurando firewall..."

# Garantir que SSH não seja bloqueado
ufw allow OpenSSH 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true

# Ativar firewall (--force para não pedir confirmação)
ufw --force enable 2>/dev/null || true

echo "    Portas 22, 80 e 443 abertas."

# ============================================================
# Pronto!
# ============================================================
echo ""
echo "============================================"
echo "  Deploy concluído com sucesso!"
echo "============================================"
echo ""
echo "  O jogo está acessível em:"
echo "    http://$(curl -s ifconfig.me 2>/dev/null || echo '<IP-DO-SERVIDOR>')"
echo ""
echo "  Comandos úteis:"
echo "    pm2 status          — ver status do servidor"
echo "    pm2 logs tornadex   — ver logs do jogo"
echo "    pm2 restart tornadex — reiniciar servidor"
echo "    bash /opt/tornadex/update.sh — atualizar código"
echo ""
