import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRetitle, cleanTitle, wantsAutoTitle } from './titles';

test('cleanTitle: first line, no quotes/markdown/prefix/trailing punctuation, capped', () => {
  assert.equal(cleanTitle('「爬山游戏改赛璐璐画风」。\n多余的解释'), '爬山游戏改赛璐璐画风');
  assert.equal(cleanTitle('\n\n**Title: Fix tunnel reconnect loop.**'), 'Fix tunnel reconnect loop');
  assert.equal(cleanTitle('# 标题：部署 NoPear'), '部署 NoPear');
  assert.equal(cleanTitle('   '), '');
  assert.equal([...cleanTitle('字'.repeat(80))].length, 40);
});

test('title precedence: user > agent > auto > prompt; only first-prompt titles get an auto title', () => {
  assert.ok(canRetitle(undefined, 'auto'));
  assert.ok(canRetitle('auto', 'agent'));
  assert.ok(canRetitle('agent', 'agent'));
  assert.ok(!canRetitle('user', 'agent'));
  assert.ok(!canRetitle('agent', 'auto'));
  assert.ok(canRetitle('user', 'user'));
  assert.ok(wantsAutoTitle(undefined) && wantsAutoTitle('prompt'));
  assert.ok(!wantsAutoTitle('auto') && !wantsAutoTitle('user'));
});
