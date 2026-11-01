from __future__ import annotations

import os
import secrets
import socket
import threading
import time
from pathlib import Path

import streamlit as st
import uvicorn

from backend.api import app as api_app, configure

ROOT = Path(__file__).parent
DIST = ROOT / "frontend" / "dist"

st.set_page_config(
    page_title="Gemma 4 Chat",
    page_icon="✳",
    layout="wide",
    initial_sidebar_state="collapsed",
    menu_items={},
)


def secret_value(key: str, section: str = "ollama", fallback: str = "") -> str:
    try:
        value = st.secrets.get(key)
        if value:
            return str(value)
        nested = st.secrets.get(section, {})
        if isinstance(nested, dict) and nested.get(key.lower()):
            return str(nested[key.lower()])
    except Exception:
        pass
    return fallback


api_key = secret_value("OLLAMA_API_KEY")
model_name = secret_value("OLLAMA_MODEL", fallback=os.getenv("OLLAMA_MODEL", "gemma4"))
api_port = int(os.getenv("CHAT_API_PORT", "8766"))
api_host = os.getenv("CHAT_API_HOST", "127.0.0.1")
api_base_url = os.getenv("CHAT_API_BASE_URL", "__AUTO__")
bridge_token = secrets.token_urlsafe(32)

configure(api_key, model_name, bridge_token)


@st.cache_resource(show_spinner=False)
def start_api_server(host: str, port: int):
    config = uvicorn.Config(api_app, host=host, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="chat-api", daemon=True)
    thread.start()
    deadline = time.time() + 12
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return server, thread, None
        except OSError:
            if not thread.is_alive():
                return server, thread, f"Could not start the API bridge on {host}:{port}."
            time.sleep(0.1)
    return server, thread, f"The API bridge did not become ready on {host}:{port}."


server, server_thread, server_error = start_api_server(api_host, api_port)

CSS = r"""
<style>
/* Streamlit chrome suppression. Keep the Streamlit runtime, remove only its visible shell. */
#MainMenu, [data-testid="stHeader"], [data-testid="stToolbar"], [data-testid="stFooter"],
header:not(.topbar), footer:not(.composer-zone),
[data-testid="stDecoration"], [data-testid="stStatusWidget"], [data-testid="stDeployButton"],
[data-testid="stAppDeployButton"], [data-testid="stAppViewBlockContainer"] > div:first-child > div:empty {
  display: none !important;
  visibility: hidden !important;
  height: 0 !important;
}
[data-testid="stSidebar"], [data-testid="collapsedControl"] { display: none !important; }
.stApp, [data-testid="stAppViewContainer"] { background: #212121 !important; }
.block-container { padding: 0 !important; max-width: 100% !important; }
[data-testid="stMainBlockContainer"] { padding: 0 !important; max-width: 100% !important; }
[data-testid="stVerticalBlock"] { gap: 0 !important; }
[data-testid="stCustomComponentV2"] { width: 100% !important; }
html, body, [data-testid="stAppViewContainer"] { overflow: hidden !important; }
</style>
"""
st.markdown(CSS, unsafe_allow_html=True)

if server_error:
    st.error(server_error)
if not api_key:
    st.warning("Add your Ollama Cloud key to `.streamlit/secrets.toml` as `OLLAMA_API_KEY`, then restart Streamlit.")

js_path = DIST / "chatbot.js"
css_path = DIST / "chatbot.css"
if not js_path.exists() or not css_path.exists():
    st.error("React frontend build is missing. From the project folder run: `cd frontend && npm install && npm run build`.")
    st.stop()

component = st.components.v2.component(
    name="gemma4_react_chat",
    html='<div id="react-chat-root"></div>',
    css=css_path.read_text(encoding="utf-8"),
    js=js_path.read_text(encoding="utf-8"),
)
component(
    data={"apiBaseUrl": api_base_url, "model": model_name, "bridgeToken": bridge_token},
    key="gemma4_react_chat_instance",
    width="stretch",
    height=900,
)
