import { useEffect, useRef, useState } from "react";
import type { Message } from "./types";

// One thread's transcript + composer. Tool rows render as an activity trail
// (time · tool · input hint); text turns as you/agent messages — design 3b.

const toolHint = (m: Message): string => {
  if (!m.tool_input) return "";
  try {
    const input = JSON.parse(m.tool_input) as Record<string, unknown>;
    const v =
      input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.prompt;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
};

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function ChatThread({
  threadId,
  busy,
  markBusy,
  placeholder = "Message the agent — add context, change course…",
}: {
  threadId: number;
  busy: boolean;
  markBusy: (threadId: number) => void;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  // In-flight assistant text, accumulated token-by-token from turn:delta.
  // The persisted row (turn:text) supersedes it, so it's cleared there —
  // never appended, which keeps the transcript free of duplicates.
  const [live, setLive] = useState("");
  // How many messages are waiting behind the running turn (queued while busy).
  // Daemon-owned: turn:queued carries the current depth, turn:done the depth
  // remaining after it hands off to the next queued message.
  const [queued, setQueued] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setLive("");
    setQueued(0);
    window.spawn.listMessages(threadId).then(setMessages);
  }, [threadId]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type === "turn:delta") {
        if (ev.payload.threadId === threadId) setLive((prev) => prev + ev.payload.text);
        return;
      }
      if (ev.type === "turn:queued") {
        if (ev.payload.threadId === threadId) setQueued(ev.payload.depth);
        return;
      }
      if (ev.type === "turn:done") {
        if (ev.payload.threadId === threadId) {
          setLive("");
          setQueued(ev.payload.queued ?? 0);
        }
        return;
      }
      if (ev.type !== "turn:text" && ev.type !== "turn:tool") return;
      if (ev.payload.threadId !== threadId) return;
      if (ev.type === "turn:text") setLive("");
      const msg = ev.payload.message;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    });
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live]);

  // Sending while the agent is busy doesn't start a second run — the daemon
  // queues the message and fires it as its own turn when the current one ends.
  // Only mark busy for a fresh turn; a queued send leaves the running turn's
  // busy state alone (the turn:queued event drives the "N queued" indicator).
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (busy) setQueued((n) => n + 1);
    else markBusy(threadId);
    await window.spawn.sendMessage(threadId, text);
    setMessages(await window.spawn.listMessages(threadId));
  };

  return (
    <>
      <div className="messages">
        {messages.map((m) =>
          m.role === "tool" ? (
            <div key={m.id} className="msg tool">
              <span className="ts">{hhmm(m.created_at)}</span>
              <span className="tool-name">{m.tool_name}</span>
              <span className="tool-in mono">{toolHint(m)}</span>
            </div>
          ) : (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role !== "system" && <div className="who">{m.role === "user" ? "you" : "agent"}</div>}
              <pre>{m.text}</pre>
            </div>
          )
        )}
        {live && (
          <div className="msg assistant">
            <div className="who">agent</div>
            <pre>
              {live}
              <span className="caret" />
            </pre>
          </div>
        )}
        {busy && !live && (
          <div className="working">
            <span className="dot-live pulse" />
            working…
          </div>
        )}
        {queued > 0 && (
          <div className="queued-note">
            {queued} message{queued > 1 ? "s" : ""} queued — will send when the agent is free
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <div className="box">
          <textarea
            value={draft}
            placeholder={busy ? "Queue a message — sends when the agent finishes…" : placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary small-btn" onClick={send} disabled={!draft.trim()}>
            {busy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </>
  );
}
