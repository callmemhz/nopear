import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { appendOnce, IN_PROCESS_FLAG, installPersonaExtension, PERSONA_EXTENSION_FILE, personaExtensionSource, rewriteSystemPrompt } from './persona';

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

/**
 * What a separate `pi` process (a background subagent) actually sends the model: real resource loading from
 * `agentDir` (auto-discovered `extensions/`), no in-process hooks.
 */
async function promptSentByChildPi(agentDir: string, home: string): Promise<string> {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'echo' }] });
  let sent = '';
  faux.setResponses([(ctx) => { sent = ctx.systemPrompt ?? ''; return fauxAssistantMessage('ok'); }]);
  const rt = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json'), refreshOnCreate: false });
  rt.registerNativeProvider(faux.provider);
  const loader = new DefaultResourceLoader({ cwd: home, agentDir, eventBus: createEventBus() });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir, model: rt.getModel('faux', 'echo'), modelRuntime: rt,
    sessionManager: SessionManager.inMemory(home), resourceLoader: loader, settingsManager: SettingsManager.inMemory() });
  await session.prompt('hi');
  session.dispose();
  return sent;
}

test('subagent pi processes: the generated extension gives them the persona; the worker process skips it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'persona-child-'));
  const bare = await promptSentByChildPi(mkdtempSync(join(tmpdir(), 'agent-')), home);
  assert.match(bare, /operating inside pi/); // what subagents sent before

  const agentDir = mkdtempSync(join(tmpdir(), 'agent-'));
  const file = installPersonaExtension(agentDir, 'Claude Code')!;
  assert.equal(file, join(agentDir, 'extensions', PERSONA_EXTENSION_FILE));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const sent = await promptSentByChildPi(agentDir, home);
  assert.ok(sent === rewriteSystemPrompt(bare, 'Claude Code'), 'byte-identical to the host rewrite');
  assert.ok(sent.startsWith('You are Claude Code, an expert coding assistant.'));

  const g = globalThis as Record<string, unknown>;
  g[IN_PROCESS_FLAG] = true;
  try { assert.match(await promptSentByChildPi(agentDir, home), /operating inside pi/); } finally { delete g[IN_PROCESS_FLAG]; }
});

test('installPersonaExtension: rewrites a stale file (persona change), leaves a current one alone, reports failure', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'agent-'));
  mkdirSync(join(agentDir, 'extensions'));
  const file = join(agentDir, 'extensions', PERSONA_EXTENSION_FILE);
  writeFileSync(file, personaExtensionSource('Old Name'));
  installPersonaExtension(agentDir, 'Claude Code');
  assert.equal(readFileSync(file, 'utf8'), personaExtensionSource('Claude Code'));
  assert.match(readFileSync(file, 'utf8'), /const PERSONA = "Claude Code";/);
  const logs: string[] = [];
  const blocked = join(agentDir, 'not-a-dir');
  writeFileSync(blocked, 'x');
  assert.equal(installPersonaExtension(blocked, 'Claude Code', (m) => logs.push(m)), null);
  assert.match(logs[0]!, /could not write/);
});
