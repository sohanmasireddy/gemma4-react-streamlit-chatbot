import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  ArrowUp, AudioLines, Check, Clipboard, File, FileText, ImagePlus,
  Mic, Paperclip, Plus, Square, X,
} from 'lucide-react';

const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.pdf,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.go,.rs,.sh,.yaml,.yml,.toml,.ini,.log,.docx,.xlsx,.pptx';
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function resolveApiBase(configured) {
  if (configured && configured !== '__AUTO__') return configured.replace(/\/$/, '');
  return `${window.location.protocol}//${window.location.hostname}:8766`;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) {
    binary += String.fromCharCode(...bytes.subarray(i, i + stride));
  }
  return btoa(binary);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(blob);
  });
}

async function compressImage(file) {
  if (!('createImageBitmap' in window)) {
    const dataUrl = await blobToDataUrl(file);
    return { dataUrl, base64: dataUrl.split(',')[1], mime: file.type || 'image/jpeg' };
  }
  const bitmap = await createImageBitmap(file);
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
  if (!blob) throw new Error(`Could not compress ${file.name}.`);
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, base64: dataUrl.split(',')[1], mime: 'image/jpeg' };
}

async function prepareFile(file) {
  if (file.size > MAX_UPLOAD_BYTES && !file.type.startsWith('image/')) {
    throw new Error(`${file.name} is larger than 12 MB.`);
  }
  if (file.type.startsWith('image/')) {
    const packed = await compressImage(file);
    return {
      id: crypto.randomUUID(), name: file.name, mime: packed.mime,
      data: packed.base64, preview: packed.dataUrl, size: file.size,
    };
  }
  const buffer = await file.arrayBuffer();
  const base64 = bytesToBase64(buffer);
  return {
    id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream',
    data: base64, preview: '', size: file.size,
  };
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentChip({ file, onRemove, compact = false }) {
  const isImage = file.mime?.startsWith('image/');
  return (
    <div className={`attachment-chip ${compact ? 'compact' : ''}`}>
      {isImage && file.preview ? (
        <img className="attachment-thumb" src={file.preview} alt="" />
      ) : (
        <span className="attachment-file-icon">{file.name.toLowerCase().endsWith('.pdf') ? <FileText size={17} /> : <File size={17} />}</span>
      )}
      <span className="attachment-meta">
        <span className="attachment-name" title={file.name}>{file.name}</span>
        {!compact && <span className="attachment-size">{formatSize(file.size || 0)}</span>}
      </span>
      {onRemove && <button type="button" className="remove-attachment" onClick={onRemove} aria-label={`Remove ${file.name}`}><X size={14} /></button>}
    </div>
  );
}

function CodeBlock({ children, className, ...props }) {
  return <code className={className} {...props}>{children}</code>;
}

function MessageActions({ content }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* Browser clipboard permission may be unavailable. */ }
  };
  return (
    <button className="message-action" onClick={copy} title="Copy response" aria-label="Copy response">
      {copied ? <Check size={15} /> : <Clipboard size={15} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export default function App({ apiBaseUrl, model, bridgeToken }) {
  const baseUrl = useMemo(() => resolveApiBase(apiBaseUrl), [apiBaseUrl]);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pendingFiles, setPendingFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const recognitionRef = useRef(null);
  const draftBeforeDictation = useRef('');

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [draft]);

  useEffect(() => () => {
    abortRef.current?.abort();
    recognitionRef.current?.stop?.();
  }, []);

  const uploadFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setNotice('');
    const room = Math.max(0, 8 - pendingFiles.length);
    for (const file of files.slice(0, room)) {
      try {
        const packed = await prepareFile(file);
        setPendingFiles((current) => [...current, packed].slice(0, 8));
      } catch (error) {
        setNotice(error.message || 'Could not prepare that file.');
      }
    }
    if (files.length > room) setNotice('You can attach up to 8 files per message.');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [pendingFiles.length]);

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    setRecording(false);
  }, []);

  const toggleDictation = () => {
    if (recording) {
      stopDictation();
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setNotice('Dictation is not available in this browser. Try the latest Chrome or Edge over HTTPS or localhost.');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    draftBeforeDictation.current = draft.trim() ? `${draft.trim()} ` : '';
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      setDraft(`${draftBeforeDictation.current}${transcript}`);
    };
    recognition.onerror = (event) => {
      setNotice(event.error === 'not-allowed' ? 'Microphone permission was blocked.' : `Dictation error: ${event.error}`);
      stopDictation();
    };
    recognition.onend = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setRecording(true);
    setNotice('');
    try { recognition.start(); } catch (error) {
      setRecording(false);
      setNotice(error.message || 'Could not start dictation.');
    }
  };

  const stopGeneration = () => abortRef.current?.abort();

  const sendMessage = async () => {
    const content = draft.trim();
    if ((!content && !pendingFiles.length) || busy) return;
    stopDictation();
    const attachments = pendingFiles.map(({ id, preview, size, ...rest }) => rest);
    const userMessage = {
      id: crypto.randomUUID(), role: 'user', content,
      attachments: pendingFiles,
    };
    const history = [...messages, userMessage];
    setMessages([...history, { id: crypto.randomUUID(), role: 'assistant', content: '', streaming: true }]);
    setDraft('');
    setPendingFiles([]);
    setNotice('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const apiMessages = history.slice(-40).map((message) => ({
        role: message.role,
        content: message.content || '',
        attachments: message.attachments?.map((file) => ({ name: file.name, mime: file.mime, data: file.data })) || [],
      }));
      // Keep full file payloads only in the request; preview metadata stays in the visible chat.
      apiMessages[apiMessages.length - 1].attachments = attachments;
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chat-Bridge-Token': bridgeToken || '' },
        body: JSON.stringify({ model, messages: apiMessages }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `Request failed (${response.status}).`;
        try {
          const payload = await response.json();
          detail = payload.detail || detail;
        } catch { /* Keep fallback text. */ }
        throw new Error(detail);
      }
      if (!response.body) throw new Error('This browser does not support streamed responses.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let answer = '';
      const updateAnswer = (chunk) => {
        answer += chunk;
        setMessages((current) => {
          const next = [...current];
          const index = next.findIndex((message) => message.streaming);
          if (index >= 0) next[index] = { ...next[index], content: answer };
          return next;
        });
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split('\n').find((part) => part.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'delta') updateAnswer(event.content || '');
          if (event.type === 'error') throw new Error(event.message || 'Ollama Cloud returned an error.');
        }
      }
      if (!answer.trim()) updateAnswer('');
      setMessages((current) => current.map((message) => message.streaming ? { ...message, streaming: false } : message));
    } catch (error) {
      if (error.name === 'AbortError') {
        setMessages((current) => current.map((message) => message.streaming ? { ...message, streaming: false, stopped: true } : message));
      } else {
        setMessages((current) => current.map((message) => message.streaming ? { ...message, content: `**Request error:** ${error.message}`, streaming: false, error: true } : message));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    uploadFiles(event.dataTransfer.files);
  };

  const isEmpty = messages.length === 0;
  const welcomePrompts = [
    { title: 'Explain a concept', detail: 'Make a difficult topic easy to understand', text: 'Explain how large language models work in simple terms.' },
    { title: 'Write something', detail: 'Draft, polish, or brainstorm', text: 'Help me write a clear, concise project update.' },
    { title: 'Analyze a file', detail: 'Summarize documents and data', text: 'Summarize the key points in the files I attach.' },
    { title: 'Help with code', detail: 'Debug, build, and improve', text: 'Help me debug this code and explain the fix.' },
  ];

  return (
    <main className="chat-shell" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>✳</span></div>
          <span className="brand-title">Gemma 4</span>
          <span className="model-tag">Ollama Cloud</span>
        </div>
        <div className="topbar-right"><span className="online-dot" /><span>Ready</span></div>
      </header>

      <section className="conversation" ref={scrollRef}>
        {isEmpty ? (
          <div className="welcome-wrap">
            <div className="welcome-symbol">✳</div>
            <h1>What can I help with?</h1>
            <p>Ask anything, share a file, or dictate your message.</p>
            <div className="prompt-grid">
              {welcomePrompts.map((prompt) => (
                <button className="prompt-card" key={prompt.title} onClick={() => setDraft(prompt.text)}>
                  <span className="prompt-title">{prompt.title}</span>
                  <span className="prompt-detail">{prompt.detail}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="messages-list">
            {messages.map((message) => (
              <article className={`message-row ${message.role}`} key={message.id}>
                {message.role === 'assistant' && <div className="assistant-avatar">✳</div>}
                <div className="message-body">
                  {message.role === 'user' ? (
                    <>
                      {message.attachments?.length > 0 && (
                        <div className="message-attachments">
                          {message.attachments.map((file) => <AttachmentChip key={file.id} file={file} compact />)}
                        </div>
                      )}
                      {message.content && <div className="user-bubble">{message.content}</div>}
                    </>
                  ) : (
                    <>
                      <div className={`assistant-content ${message.error ? 'error-content' : ''}`}>
                        {message.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ code: CodeBlock }}>
                            {message.content}
                          </ReactMarkdown>
                        ) : message.streaming ? <span className="thinking-pulse"><i /><i /><i /></span> : null}
                        {message.streaming && message.content && <span className="stream-cursor" />}
                      </div>
                      {message.stopped && <div className="stopped-label">Generation stopped</div>}
                      {message.content && !message.streaming && !message.error && <MessageActions content={message.content} />}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className="composer-zone">
        {notice && <div className="notice-line" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={13} /></button></div>}
        <div className={`composer ${dragging ? 'dragging' : ''}`}>
          {pendingFiles.length > 0 && (
            <div className="pending-files">
              {pendingFiles.map((file) => (
                <AttachmentChip key={file.id} file={file} onRemove={() => setPendingFiles((current) => current.filter((item) => item.id !== file.id))} />
              ))}
            </div>
          )}
          {dragging && <div className="drop-overlay"><ImagePlus size={20} /> Drop files to attach</div>}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Gemma 4"
            aria-label="Message Gemma 4"
          />
          <div className="composer-toolbar">
            <div className="composer-left">
              <button className="tool-button attach-button" type="button" title="Attach files" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <Plus size={19} /><span>Attach</span>
              </button>
              <input ref={fileInputRef} className="hidden-input" type="file" accept={ACCEPT} multiple onChange={(event) => uploadFiles(event.target.files)} />
              <button className={`tool-button dictation-button ${recording ? 'recording' : ''}`} type="button" title={recording ? 'Stop dictation' : 'Dictate'} onClick={toggleDictation} disabled={busy}>
                {recording ? <AudioLines size={18} /> : <Mic size={18} />}
                <span>{recording ? 'Listening' : 'Dictate'}</span>
              </button>
            </div>
            <div className="composer-right">
              {busy ? (
                <button className="send-button stop-button" type="button" onClick={stopGeneration} title="Stop generating"><Square size={13} fill="currentColor" /></button>
              ) : (
                <button className="send-button" type="button" onClick={sendMessage} disabled={!draft.trim() && pendingFiles.length === 0} title="Send message"><ArrowUp size={19} /></button>
              )}
            </div>
          </div>
        </div>
        <p className="disclaimer">Gemma 4 can make mistakes. Check important information.</p>
      </footer>
    </main>
  );
}
