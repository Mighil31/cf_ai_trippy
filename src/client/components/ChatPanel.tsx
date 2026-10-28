import type { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, type FormEvent, type RefObject } from "react";

type Chat = ReturnType<typeof useAgentChat>;

const SUGGESTIONS = [
  "Plan the first day for us",
  "Where should we stay?",
  "Make day 2 a day trip somewhere nearby",
  "We're vegetarian — keep that in mind"
];

export function ChatPanel({
  chat,
  input,
  setInput,
  inputRef
}: {
  chat: Chat;
  /** Lifted so plan actions ("Ask Trippy") can prefill the message. */
  input: string;
  setInput: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { messages, sendMessage, status, stop, error } = chat;
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    setInput("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }

  return (
    <section
      aria-label="Chat with Trippy"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="space-y-3 text-sm">
            <p className="text-neutral-600 dark:text-neutral-400">
              Tell Trippy what you'd like: plan a day, add a restaurant, move
              things around, or set rules like "no early mornings".
            </p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-neutral-300 px-3 py-1 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m: UIMessage) => (
          <Message key={m.id} message={m} />
        ))}
        {status === "submitted" && (
          <p className="text-sm text-neutral-500">Trippy is thinking…</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error.message}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={submit}
        className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800"
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={2}
          placeholder="Message Trippy…"
          aria-label="Message Trippy"
          className="min-w-0 flex-1 resize-none rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => stop()}
            className="rounded-md border border-neutral-300 px-3 text-sm dark:border-neutral-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-md bg-orange-600 px-4 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </section>
  );
}

function Message({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "space-y-1.5"}>
      {message.parts.map((part, i) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return (
            <p
              key={i}
              className={
                isUser
                  ? "max-w-[85%] rounded-2xl rounded-br-sm bg-orange-600 px-3 py-2 text-sm whitespace-pre-wrap text-white"
                  : "text-sm whitespace-pre-wrap"
              }
            >
              {part.text}
            </p>
          );
        }
        if (isToolUIPart(part)) {
          return <ToolChip key={i} part={part} />;
        }
        return null;
      })}
    </div>
  );
}

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function ToolChip({ part }: { part: ToolPart }) {
  const name = getToolName(part).replace(/_/g, " ");
  let label = `${name}…`;
  let tone = "text-neutral-500";

  if (part.state === "output-available") {
    const out = part.output as {
      ok: boolean;
      summary?: string;
      error?: string;
    };
    if (out?.ok) {
      label = `✓ ${out.summary}`;
      tone = "text-emerald-700 dark:text-emerald-400";
    } else {
      label = `✗ ${name}: ${out?.error ?? "failed"}`;
      tone = "text-amber-700 dark:text-amber-400";
    }
  } else if (part.state === "output-error") {
    label = `✗ ${name}: ${part.errorText}`;
    tone = "text-amber-700 dark:text-amber-400";
  }

  return <p className={`text-xs ${tone}`}>{label}</p>;
}
