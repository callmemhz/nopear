// Assistant markdown via react-native-marked's hook (returns plain elements — no nested FlatList inside our chat list).
import { Fragment, memo, useState, type ReactNode } from 'react';
import { View, useColorScheme, type ImageStyle } from 'react-native';
import { Renderer, useMarkdown } from 'react-native-marked';

/**
 * Never auto-load remote images from model output (an <img> URL is an exfiltration channel).
 * Images render as a tappable link instead; opening it is an explicit user action.
 */
class SafeRenderer extends Renderer {
  override image(uri: string, alt?: string, _style?: ImageStyle, title?: string): ReactNode {
    return this.link(`🖼 ${alt || title || '图片'}（点此打开）`, uri);
  }
  override linkImage(href: string, _imageUrl: string, alt?: string, _style?: ImageStyle, title?: string): ReactNode {
    return this.link(`🖼 ${alt || title || '图片链接'}`, href);
  }
}
import { rendererPerText } from '../rendererPerText';
import { mono, usePalette } from '../theme';

function MarkdownImpl({ text }: { text: string }) {
  const c = usePalette();
  const scheme = useColorScheme();
  // Fresh renderer per text, one getter per component instance (see rendererPerText for why).
  const [rendererFor] = useState(() => rendererPerText(() => new SafeRenderer()));
  const renderer = rendererFor(text);
  const nodes = useMarkdown(text, {
    colorScheme: scheme,
    renderer,
    theme: { colors: { text: c.text, link: c.tint, code: c.code, border: c.sep } },
    styles: {
      text: { fontSize: 16, lineHeight: 23, color: c.text },
      paragraph: { paddingVertical: 3 },
      codespan: { ...mono, fontSize: 14, backgroundColor: c.code },
      code: { backgroundColor: c.code, borderRadius: 8, padding: 10, marginVertical: 6 },
      codeText: { ...mono, fontSize: 13, color: c.text },
      h1: { fontSize: 22, fontWeight: '700', color: c.text, marginVertical: 6 },
      h2: { fontSize: 19, fontWeight: '700', color: c.text, marginVertical: 5 },
      h3: { fontSize: 17, fontWeight: '700', color: c.text, marginVertical: 4 },
      blockquote: { borderLeftWidth: 3, borderLeftColor: c.sep, paddingLeft: 10, marginVertical: 4 },
      li: { fontSize: 16, lineHeight: 23, color: c.text },
    },
  });
  return <View>{nodes.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</View>;
}

export const Markdown = memo(MarkdownImpl);
