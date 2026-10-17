import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { appendOnce, rewriteSystemPrompt } from './persona';

/** Capture pi 0.84.4's real assembled default system prompt via a before_agent_start hook. */
async function realDefaultPrompt(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'persona-'));
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'echo' }] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  const rt = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
  rt.registerNativeProvider(faux.provider);
  let captured = '';
  const loader = new DefaultResourceLoader({
    cwd: home, agentDir: join(home, 'agent'), eventBus: createEventBus(),
    extensionFactories: [(pi) => { pi.on('before_agent_start', (e) => { captured = e.systemPrompt; }); }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: join(home, 'agent'), model: rt.getModel('faux', 'echo'), modelRuntime: rt,
    sessionManager: SessionManager.inMemory(home), resourceLoader: loader, settingsManager: SettingsManager.inMemory() });
  await session.prompt('hi');
  session.dispose();
  return captured;
}

test('rewrites the real pi default prompt into the persona', async () => {
  const base = await realDefaultPrompt();
  assert.match(base, /operating inside pi/);
  assert.match(base, /Pi documentation/);
  const out = rewriteSystemPrompt(base, 'Claude Code')!;
  assert.doesNotMatch(out, /operating inside pi/);
  assert.doesNotMatch(out, /Pi documentation/);
  assert.doesNotMatch(out, /docs\/extensions\.md/);
  assert.ok(out.startsWith('You are Claude Code, an expert coding assistant.'));
  assert.match(out, /Available tools:/);
  assert.match(out, /Current working directory:/);
  assert.ok(out.trimEnd().endsWith('When asked who or what you are, say you are Claude Code.'));
});

test('undefined base stays undefined; custom persona is used', () => {
  assert.equal(rewriteSystemPrompt(undefined, 'Claude Code'), undefined);
  const out = rewriteSystemPrompt('custom prompt', 'NoPear Bot')!;
  assert.match(out, /^custom prompt/);
  assert.ok(out.endsWith('say you are NoPear Bot.'));
});

test('rewriteSystemPrompt is idempotent (SYSTEM.md rewritten by override, then again by before_agent_start)', async () => {
  const base = await realDefaultPrompt();
  for (const x of [base, 'custom prompt', 'custom\n\nPi documentation (x):\n- a\n- b\n']) {
    const once = rewriteSystemPrompt(x, 'Claude Code')!;
    assert.equal(rewriteSystemPrompt(once, 'Claude Code'), once);
    assert.equal(once.split('When asked who or what you are').length - 1, 1);
  }
});

test('appendOnce adds the PM append exactly once', () => {
  const p = rewriteSystemPrompt('custom prompt', 'Claude Code')!;
  const once = appendOnce(p, 'PM RULES\nline2')!;
  assert.equal(appendOnce(once, 'PM RULES\nline2'), once);
  assert.equal(once.split('PM RULES').length - 1, 1);
  assert.equal(appendOnce(p, undefined), p);
  assert.equal(appendOnce(undefined, 'x'), undefined);
});
