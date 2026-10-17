// One tool call (+ its live progress and final result) rendered as a compact, expandable card.
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Block } from '@nopear/protocol';
import type { EntryState } from '@nopear/core';
import { mono, usePalette } from '../theme';
import { BlobImage } from './BlobImage';
import { Icon } from './Icon';

type Call = Extract<Block, { type: 'tool_call' }>;
type Result = Extract<Block, { type: 'tool_result' }>;
type Image = Extract<Block, { type: 'image' }>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'bash': return str(i.command).split('\n')[0] ?? '';
    case 'read': case 'write': case 'edit': return str(i.path) || str(i.file_path);
    case 'grep': return `${str(i.pattern)}${i.path ? `  ${str(i.path)}` : ''}`;
    case 'find': case 'ls': return str(i.pattern) || str(i.path) || '.';
    case 'ask_user_question': {
      const q = Array.isArray(i.questions) ? i.questions.length : 0;
      return `${q} 个问题`;
    }
    case 'subagent': return str(i.task).split('\n')[0] || str(i.agent);
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first.split('\n')[0] ?? '' : '';
    }
  }
}

export function ToolCard({ call, result, progress, orphan, images, workerId, state }: {
  call?: Call; result?: Result; progress?: string; orphan?: boolean; images?: Image[]; workerId?: string;
  /** From the tool group (entryState): distinguishes a running call from one still pending. */
  state?: EntryState;
}) {
  const c = usePalette();
  const [open, setOpen] = useState(false);
  const name = call?.name ?? result?.toolName ?? 'tool';
  const st: EntryState = state ?? (result ? (result.isError ? 'error' : 'ok') : call ? 'running' : 'pending');
  const running = st === 'running';
  const failed = st === 'error';
  const summary = call ? toolSummary(call.name, call.input) : orphan ? '（结果）' : '';
  const body = result?.text ?? progress ?? '';
  return (
    <View style={{ backgroundColor: c.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.sep, marginVertical: 3, overflow: 'hidden' }}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 8 }}>
        {running ? <ActivityIndicator size="small" color={c.tint} style={{ transform: [{ scale: 0.7 }], width: 14, height: 14 }} />
          : <Text style={{ width: 14, textAlign: 'center', color: failed ? c.danger : st === 'pending' ? c.faint : c.ok, fontSize: 12 }}>{failed ? '✕' : st === 'pending' ? '○' : '✓'}</Text>}
        <Text style={{ color: c.text, fontWeight: '600', fontSize: 13.5 }}>{name}</Text>
        <Text style={{ color: c.sub, fontSize: 12.5, flex: 1, ...mono }} numberOfLines={1}>{summary}</Text>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}><Icon name="chevronRight" size={14} color={c.faint} /></View>
      </Pressable>
      {running && progress && !open ? (
        <Text style={{ color: c.sub, fontSize: 12, paddingHorizontal: 10, paddingBottom: 8, ...mono }} numberOfLines={3}>
          {progress.split('\n').slice(-3).join('\n')}
        </Text>
      ) : null}
      {open ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 8 }}>
          {call ? (
            <ScrollView horizontal>
              <Text selectable style={{ color: c.sub, fontSize: 12, ...mono }}>{JSON.stringify(call.input, null, 2)}</Text>
            </ScrollView>
          ) : null}
          {body ? (
            <ScrollView style={{ maxHeight: 320 }} nestedScrollEnabled>
              <Text selectable style={{ color: failed ? c.danger : c.text, fontSize: 12, ...mono }}>{body}</Text>
            </ScrollView>
          ) : running ? <Text style={{ color: c.sub, fontSize: 12 }}>运行中…</Text> : null}
        </View>
      ) : null}
      {images && images.length > 0 && workerId !== undefined ? (
        // Images the tool returned (e.g. read on a png): shown under the result, even when collapsed.
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, paddingBottom: 8 }}>
          {images.map((im, i) => <BlobImage key={i} workerId={workerId} hash={im.blob} mediaType={im.mediaType} />)}
        </View>
      ) : null}
    </View>
  );
}
