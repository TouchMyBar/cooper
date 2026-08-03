import type { ReactNode } from "react";

// Minimal inline-markdown renderer for list cards: **bold**, *italic*,
// ~~strikethrough~~, `code`. Underscore emphasis is deliberately not supported
// so captured snake_case/__dunder__ code doesn't get mangled. No dependencies,
// no HTML injection — output is plain React elements.
const TOKEN = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*)/;

export function renderInline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    // split() with a capturing group interleaves: even indices are plain text.
    if (i % 2 === 0) return part;
    if (part.startsWith("**")) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith("~~")) return <s key={i}>{part.slice(2, -2)}</s>;
    if (part.startsWith("`"))
      return (
        <code key={i} className="md-code">
          {part.slice(1, -1)}
        </code>
      );
    return <i key={i}>{part.slice(1, -1)}</i>;
  });
}
