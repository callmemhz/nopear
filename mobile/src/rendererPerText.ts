// Renderer lifetime policy for components/Markdown.tsx (pure; no RN imports so it is unit-testable).
// react-native-marked's Renderer is stateful (github-slugger element keys, table widths): it must be fresh for
// every distinct text — reusing one across streamed deltas keeps advancing its key counter, so every delta would
// produce new keys and remount the whole message — but stable across re-renders of the same text. Create one
// getter per component instance (never module-level, which would leak that state across all messages).
export function rendererPerText<R>(make: () => R): (text: string) => R {
  let cur: { text: string; renderer: R } | undefined;
  return (text) => {
    if (!cur || cur.text !== text) cur = { text, renderer: make() };
    return cur.renderer;
  };
}
