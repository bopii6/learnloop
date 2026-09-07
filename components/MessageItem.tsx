"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredMessage } from "@/types";
import { CollapsedTimeline } from "./StageTimeline";
import { SourcesStrip } from "./SourcesStrip";

/** 把正文里的 [n] 转成链接锚点，交给 markdown 渲染成角标 */
function linkifyCitations(text: string, sourceCount: number): string {
  return text.replace(/\[(\d{1,2})\]/g, (m, n) => {
    const idx = Number(n);
    if (idx >= 1 && idx <= sourceCount) return `[$1](#cite-${idx})`.replace("$1", n);
    return m;
  });
}

export function MessageItem({
  msg,
  onCite,
  highlight,
}: {
  msg: StoredMessage;
  onCite: (index: number) => void;
  highlight: number | null;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end fade-up">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent-soft border border-accent-border/40 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }

  const sourceCount = msg.sources?.length || 0;
  const content = linkifyCitations(msg.content, sourceCount);

  return (
    <div className="fade-up">
      {msg.stages && msg.stages.length > 0 && (
        <CollapsedTimeline stages={msg.stages} />
      )}
      <div className="md text-[14.5px] text-ink">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              if (href && href.startsWith("#cite-")) {
                const idx = Number(href.replace("#cite-", ""));
                return (
                  <button
                    className="cite-badge"
                    onClick={(e) => {
                      e.preventDefault();
                      onCite(idx);
                    }}
                  >
                    {children}
                  </button>
                );
              }
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
      {msg.sources && msg.sources.length > 0 && (
        <SourcesStrip sources={msg.sources} highlight={highlight} />
      )}
    </div>
  );
}
