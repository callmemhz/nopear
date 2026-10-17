import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Markdown images are NEVER auto-fetched (a remote URL could exfiltrate data); render a link instead. */
function SafeImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const href = typeof src === 'string' ? src : '';
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs panel" title={href}>
      🖼 {alt || '图片'}（点击打开）
    </a>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" />,
          img: ({ node: _n, src, alt }) => <SafeImage src={src} alt={alt} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
