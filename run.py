#!/usr/bin/env python3
"""
Bihar Citizen Echo - Cross-Platform Single Command Server Launcher
Usage:
    python3 run.py
"""

import sys
import os
import subprocess
import webbrowser
import time

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

def check_venv():
    venv_dir = os.path.join(BASE_DIR, ".venv")
    venv_python = os.path.join(venv_dir, "bin", "python3")
    if sys.platform == "win32":
        venv_python = os.path.join(venv_dir, "Scripts", "python.exe")

    if not os.path.exists(venv_python):
        print("⚡ [SETUP] Creating isolated Python virtual environment...")
        subprocess.check_call([sys.executable, "-m", "venv", venv_dir])
        pip_exe = os.path.join(venv_dir, "bin", "pip") if sys.platform != "win32" else os.path.join(venv_dir, "Scripts", "pip.exe")
        req_file = os.path.join(BASE_DIR, "requirements.txt")
        if os.path.exists(req_file):
            print("⚡ [SETUP] Installing requirements...")
            subprocess.check_call([pip_exe, "install", "-r", req_file])
    return venv_python

def main():
    os.chdir(BASE_DIR)
    sys.path.insert(0, BASE_DIR)
    
    print("\n" + "=" * 65)
    print("   🇮🇳 BIHAR CITIZEN ECHO // LOCAL CIVIC INTELLIGENCE PLATFORM")
    print("=" * 65)
    print("🌐 Web Dashboard:         http://localhost:8000")
    print("⚡ WebSocket Hub:         ws://localhost:8000/ws/hub")
    print("📖 Swagger API Docs:      http://localhost:8000/docs")
    print("-" * 65)
    print("🧩 Chrome Extensions (Load in chrome://extensions):")
    print(f"  1. 🕷️ Bihar News Scraper:    {os.path.join(BASE_DIR, 'extensions', 'bihar_news_scraper')}")
    print(f"  2. 🧠 DeepSeek Automator:    {os.path.join(BASE_DIR, 'extensions', 'deepseek_automator')}")
    print(f"  3. ⚖️ Severity Analyzer:     {os.path.join(BASE_DIR, 'extensions', 'civic_severity_scorer')}")
    print(f"  4. 🛡️ Fact-Checker Ext:      {os.path.join(BASE_DIR, 'extensions', 'regional_fact_checker')}")
    print("=" * 65 + "\n")

    venv_py = check_venv()
    cmd = [
        venv_py, "-m", "uvicorn", "backend.app:app",
        "--host", "0.0.0.0",
        "--port", "8000",
        "--reload"
    ]
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n🛑 Server stopped gracefully.")

if __name__ == "__main__":
    main()
