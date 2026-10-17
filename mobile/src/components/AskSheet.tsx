// Answer an ask_user_question prompt: single/multi select per question + optional free-form note.
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import type { Prompt } from '@nopear/protocol';
import { Button, Field, Section, Sheet, usePalette } from '../theme';

export function AskSheet(props: { prompt: Prompt | null; onClose: () => void; onSubmit: (answers: Record<string, string>, note?: string) => Promise<void> }) {
  const c = usePalette();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSel({}); setNote(''); }, [props.prompt?.id]);
  const p = props.prompt;
  if (!p) return null;
  const toggle = (q: string, label: string, multi: boolean) => setSel((s) => {
    const cur = s[q] ?? [];
    return { ...s, [q]: multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  const complete = p.questions.every((q) => (sel[q.question]?.length ?? 0) > 0) || note.trim().length > 0;
  const submit = async () => {
    const answers: Record<string, string> = {};
    for (const q of p.questions) {
      const picked = q.options.map((o) => o.label).filter((l) => sel[q.question]?.includes(l));
      if (picked.length) answers[q.question] = picked.join(', ');
    }
    setBusy(true);
    try { await props.onSubmit(answers, note.trim() || undefined); props.onClose(); }
    catch (e) { Alert.alert('提交失败', e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible title="需要你的回答" onClose={props.onClose}>
      {p.questions.map((q) => (
        <Section key={q.question} title={q.header || (q.multiSelect ? '多选' : '单选')}>
          <View style={{ padding: 14, gap: 10 }}>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>{q.question}</Text>
            {q.options.map((o) => {
              const on = sel[q.question]?.includes(o.label) ?? false;
              return (
                <Pressable key={o.label} onPress={() => toggle(q.question, o.label, q.multiSelect)}
                  style={{ borderRadius: 10, borderWidth: 1.5, borderColor: on ? c.tint : c.sep, padding: 10, backgroundColor: on ? c.accentSoft : 'transparent' }}>
                  <Text style={{ color: c.text, fontSize: 15, fontWeight: on ? '600' : '400' }}>{q.multiSelect ? (on ? '☑︎ ' : '☐ ') : on ? '◉ ' : '○ '}{o.label}</Text>
                  {o.description ? <Text style={{ color: c.sub, fontSize: 13, marginTop: 2 }}>{o.description}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </Section>
      ))}
      <View style={{ margin: 16, gap: 12 }}>
        <Field label="补充说明（可选）" value={note} onChangeText={setNote} multiline placeholder="其它想法…" />
        <Button title="提交" onPress={submit} busy={busy} disabled={!complete} />
      </View>
    </Sheet>
  );
}
