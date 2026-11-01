from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import secrets
from functools import lru_cache
from typing import Any, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ollama import AsyncClient, ResponseError
from pydantic import BaseModel, Field

API_KEY: str | None = None
DEFAULT_MODEL = "gemma4"
BRIDGE_TOKEN: str | None = None
MAX_FILE_BYTES = 12 * 1024 * 1024
MAX_TEXT_CHARS = 120_000
MAX_MESSAGES = 40

app = FastAPI(title="Gemma 4 Chat API", docs_url=None, redoc_url=None)

_origins = [x.strip() for x in os.getenv("CHAT_API_ALLOWED_ORIGINS", "http://localhost:8501,http://127.0.0.1:8501").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=os.getenv("CHAT_API_ALLOWED_ORIGIN_REGEX") or None,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Chat-Bridge-Token"],
)


class Attachment(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    mime: str = Field(default="application/octet-stream", max_length=160)
    data: str = Field(min_length=1)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(default="", max_length=MAX_TEXT_CHARS)
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)


class ChatPayload(BaseModel):
    model: str = Field(default=DEFAULT_MODEL, min_length=1, max_length=100)
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)


def configure(api_key: str | None, model: str = DEFAULT_MODEL, bridge_token: str | None = None) -> None:
    """Inject Streamlit secrets into the private server process; never send the key to React."""
    global API_KEY, DEFAULT_MODEL, BRIDGE_TOKEN
    API_KEY = api_key.strip() if isinstance(api_key, str) and api_key.strip() else None
    DEFAULT_MODEL = model.strip() or "gemma4"
    BRIDGE_TOKEN = bridge_token
    _ollama_client.cache_clear()


@lru_cache(maxsize=1)
def _ollama_client() -> AsyncClient:
    if not API_KEY:
        raise RuntimeError("OLLAMA_API_KEY is missing in Streamlit secrets.")
    return AsyncClient(
        host="https://ollama.com",
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=httpx.Timeout(connect=15.0, read=180.0, write=60.0, pool=15.0),
        trust_env=False,
    )


def _decode_file(data: str) -> bytes:
    # Browser sends raw base64, not a data: URL. Still strip a data URL defensively.
    if data.startswith("data:") and "," in data:
        data = data.split(",", 1)[1]
    try:
        decoded = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("An attachment was not valid base64 data.") from exc
    if len(decoded) > MAX_FILE_BYTES:
        raise ValueError("Each uploaded file must be 12 MB or smaller after image compression.")
    return decoded


def _extract_text(filename: str, raw: bytes) -> str:
    ext = os.path.splitext(filename.lower())[1]
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        sections = []
        for page_num, page in enumerate(reader.pages[:80], start=1):
            value = page.extract_text() or ""
            if value.strip():
                sections.append(f"[Page {page_num}]\n{value}")
        return "\n\n".join(sections)[:MAX_TEXT_CHARS]

    if ext == ".docx":
        from docx import Document

        doc = Document(io.BytesIO(raw))
        chunks = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables[:30]:
            for row in table.rows[:100]:
                chunks.append(" | ".join(cell.text.replace("\n", " ") for cell in row.cells))
        return "\n".join(chunks)[:MAX_TEXT_CHARS]

    if ext == ".xlsx":
        from openpyxl import load_workbook

        book = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        chunks = []
        for sheet in book.worksheets[:12]:
            chunks.append(f"[Sheet: {sheet.title}]")
            for row in sheet.iter_rows(max_row=250, values_only=True):
                chunks.append(" | ".join("" if cell is None else str(cell) for cell in row))
        book.close()
        return "\n".join(chunks)[:MAX_TEXT_CHARS]

    if ext == ".pptx":
        from pptx import Presentation

        deck = Presentation(io.BytesIO(raw))
        chunks = []
        for idx, slide in enumerate(deck.slides[:80], start=1):
            lines = []
            for shape in slide.shapes:
                if getattr(shape, "has_text_frame", False) and shape.text.strip():
                    lines.append(shape.text.strip())
            chunks.append(f"[Slide {idx}]\n" + "\n".join(lines))
        return "\n\n".join(chunks)[:MAX_TEXT_CHARS]

    # Text/code/CSV/JSON and other text-like uploads.
    try:
        return raw.decode("utf-8-sig")[:MAX_TEXT_CHARS]
    except UnicodeDecodeError:
        return f"[Could not extract readable text from {filename}.]"


def _to_ollama_messages(messages: list[ChatMessage]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for msg in messages:
        content = msg.content.strip()
        images: list[bytes] = []
        attachment_notes: list[str] = []
        for attachment in msg.attachments:
            raw = _decode_file(attachment.data)
            mime = attachment.mime.lower()
            name = attachment.name
            if mime.startswith("image/"):
                images.append(raw)
            else:
                extracted = _extract_text(name, raw)
                if extracted.strip():
                    attachment_notes.append(f"[Attached file: {name}]\n{extracted}")
                else:
                    attachment_notes.append(f"[Attached file: {name}; no extractable text was found.]")
        if attachment_notes:
            content = (content + "\n\n" + "\n\n".join(attachment_notes)).strip()
        if not content and not images:
            continue
        item: dict[str, Any] = {"role": msg.role, "content": content}
        if images:
            item["images"] = images
        output.append(item)
    return output


def _sse(event: dict[str, Any]) -> bytes:
    return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "configured": bool(API_KEY), "model": DEFAULT_MODEL}


@app.post("/api/chat")
async def chat(payload: ChatPayload, x_chat_bridge_token: str | None = Header(default=None)) -> StreamingResponse:
    if not BRIDGE_TOKEN or not secrets.compare_digest(x_chat_bridge_token or "", BRIDGE_TOKEN):
        raise HTTPException(status_code=403, detail="The chat bridge token is missing or invalid. Reload the app and try again.")
    if not API_KEY:
        raise HTTPException(status_code=503, detail="Add OLLAMA_API_KEY to .streamlit/secrets.toml and restart the app.")

    # Restrict model selection to the configured model so the browser cannot request arbitrary model IDs.
    selected_model = DEFAULT_MODEL
    try:
        ollama_messages = _to_ollama_messages(payload.messages)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not ollama_messages:
        raise HTTPException(status_code=400, detail="Send a message or attach a file first.")

    async def token_stream():
        try:
            client = _ollama_client()
            stream = await client.chat(
                model=selected_model,
                messages=ollama_messages,
                stream=True,
                options={"temperature": 0.7, "top_p": 0.9},
            )
            async for part in stream:
                text = part.message.content or ""
                if text:
                    yield _sse({"type": "delta", "content": text})
            yield _sse({"type": "done"})
        except ResponseError as exc:
            message = getattr(exc, "error", None) or str(exc)
            yield _sse({"type": "error", "message": message[:1600]})
        except httpx.TimeoutException:
            yield _sse({"type": "error", "message": "The Ollama Cloud request timed out. Try again or shorten the conversation."})
        except Exception as exc:  # Surface a useful message while keeping credentials server-side.
            message = str(exc).strip() or "Unknown Ollama Cloud error."
            # Do not leak request headers or secret values in error messages.
            message = re.sub(r"Bearer\s+\S+", "Bearer [redacted]", message, flags=re.I)
            yield _sse({"type": "error", "message": message[:1600]})

    return StreamingResponse(
        token_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
