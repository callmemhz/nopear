// Process-wide pi ModelRuntime.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelInfo } from '@nopear/protocol';
import type { WorkerConfig } from '../config';
import { maybeRegisterFaux } from './faux';

export async function createModelRuntime(cfg: WorkerConfig): Promise<ModelRuntime> {
  const rt = await ModelRuntime.create({ authPath: cfg.piAuthPath, modelsPath: cfg.piModelsPath });
  maybeRegisterFaux(rt);
  return rt;
}

export const modelKey = (m: Model<Api>): string => `${m.provider}/${m.id}`;

export async function listModels(rt: ModelRuntime): Promise<ModelInfo[]> {
  const models = await rt.getAvailable();
  return models.map((m) => ({ id: modelKey(m), name: m.name || m.id, reasoning: Boolean(m.reasoning) }));
}

export function resolveModel(rt: ModelRuntime, id: string): Model<Api> | undefined {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) return undefined;
  return rt.getModel(id.slice(0, i), id.slice(i + 1));
}
