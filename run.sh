#!/usr/bin/env bash
# =====================================================================
# 🇮🇳 BIHAR CITIZEN ECHO - ONE-COMMAND PRODUCTION RUNNER
# Autonomous News Scraping, Civic Grievance Analysis & AI Orchestration
# =====================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "====================================================================="
echo "   🇮🇳 BIHAR CITIZEN ECHO // LOCAL CIVIC INTELLIGENCE PLATFORM       "
echo "====================================================================="
echo -e "${NC}"

# 1. Check Python installation
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}[ERROR] Python 3 is not installed or not in PATH.${NC}"
    exit 1
fi

# 2. Virtual Environment Setup
if [ ! -d ".venv" ]; then
    echo -e "${YELLOW}[SETUP] Creating isolated Python virtual environment (.venv)...${NC}"
    python3 -m venv .venv
    echo -e "${YELLOW}[SETUP] Installing required dependencies...${NC}"
    .venv/bin/pip install --upgrade pip
    .venv/bin/pip install -r requirements.txt
fi

# 3. Port check (Port 8000)
if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null ; then
    OCCUPIED_PID=$(lsof -Pi :8000 -sTCP:LISTEN -t | head -n 1)
    echo -e "${YELLOW}[INFO] Port 8000 is currently occupied by PID ${OCCUPIED_PID}.${NC}"
    echo -e "${YELLOW}[INFO] Freeing port 8000...${NC}"
    kill -9 $OCCUPIED_PID 2>/dev/null || true
    sleep 1
fi

# 4. Display System Routing & Instructions
echo -e "${GREEN}✓ Environment Verified & Ready${NC}"
echo -e "${CYAN}---------------------------------------------------------------------${NC}"
echo -e "🌐 Web Dashboard:         ${GREEN}http://localhost:8000${NC}"
echo -e "⚡ WebSocket Hub:         ${GREEN}ws://localhost:8000/ws/hub${NC}"
echo -e "📖 Swagger API Docs:      ${GREEN}http://localhost:8000/docs${NC}"
echo -e "${CYAN}---------------------------------------------------------------------${NC}"
echo -e "🧩 Chrome Extensions (Load in chrome://extensions with Developer Mode):"
echo -e "  1. 🕷️ Bihar News Scraper:    ${YELLOW}$DIR/extensions/bihar_news_scraper${NC}"
echo -e "  2. 🧠 DeepSeek Automator:    ${YELLOW}$DIR/extensions/deepseek_automator${NC}"
echo -e "  3. ⚖️ Severity Analyzer:     ${YELLOW}$DIR/extensions/civic_severity_scorer${NC}"
echo -e "  4. 🛡️ Fact-Checker Ext:      ${YELLOW}$DIR/extensions/regional_fact_checker${NC}"
echo -e "${CYAN}---------------------------------------------------------------------${NC}"
echo -e "Starting server... (Press Ctrl+C to stop)"
echo ""

export PYTHONPATH="$DIR"
exec .venv/bin/python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
