"use client";

import { useEffect, useRef } from "react";

interface MermaidRendererProps {
  code: string;
}

export function MermaidRenderer({ code }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !code) return;

    // 动态加载 mermaid
    const render = async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "loose",
        });

        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, code);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (e) {
        console.error("Mermaid render error:", e);
        if (containerRef.current) {
          containerRef.current.innerHTML = `<pre class="text-[12px] text-ink-soft whitespace-pre-wrap">${code}</pre>`;
        }
      }
    };

    render();
  }, [code]);

  return (
    <div
      ref={containerRef}
      className="mermaid-container overflow-x-auto py-4 flex justify-center"
      style={{ minHeight: 200 }}
    />
  );
}
