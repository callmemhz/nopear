import { describe, expect, it } from 'vitest';
import type { Machine, MachineUpdate } from '@nopear/protocol';
import { machineUpdateView, updateCommand } from './machineUpdate';

const m = (update: MachineUpdate | undefined, p: Partial<Machine> = {}): Machine =>
  ({ workerId: 'w', label: 'box', workerPub: '', online: true, lastSeenAt: null, version: '3.2.0', ...(update ? { update } : {}), ...p });
const URL = 'https://nopear.dev/';

describe('machineUpdateView', () => {
  it('offline → nothing', () => {
    expect(machineUpdateView(m({ self: true, build: 'a', latest: 'b' }, { online: false }), URL)).toBeNull();
    expect(machineUpdateView(m(undefined), URL)).toBeNull();
  });
  it('behind + self → one-click; behind without a service → the command', () => {
    expect(machineUpdateView(m({ self: true, build: 'a', latest: 'b' }), URL)).toMatchObject({ label: '有新版本', canUpdate: true });
    const v = machineUpdateView(m({ self: false, build: 'a', latest: 'b' }), URL)!;
    expect(v.canUpdate).toBe(false);
    expect(v.command).toBe('curl -fsSL https://nopear.dev/update.sh | bash');
  });
  it('up to date, source checkout, pre-3.2 worker', () => {
    expect(machineUpdateView(m({ self: true, build: 'a', latest: 'a' }), URL)).toMatchObject({ label: '已是最新', canUpdate: false, tone: 'ok' });
    expect(machineUpdateView(m({ self: false }), URL)).toMatchObject({ label: '源码运行', canUpdate: false });
    const old = machineUpdateView(m({ self: false, latest: 'b' }, { version: '3.1.0' }), URL)!;
    expect(old.label).toBe('旧版本');
    expect(old.command).toBe(updateCommand(URL));
  });
  it('in progress / failed', () => {
    expect(machineUpdateView(m({ self: true, build: 'a', latest: 'b', state: 'waiting', message: '等 2 个会话空闲后重启' }), URL))
      .toMatchObject({ label: '等 2 个会话空闲后重启', tone: 'busy', canUpdate: false });
    expect(machineUpdateView(m({ self: true, build: 'a', latest: 'b', state: 'failed', message: 'npm ERR!' }), URL))
      .toMatchObject({ label: '更新失败：npm ERR!', tone: 'bad', canUpdate: true });
  });
});
