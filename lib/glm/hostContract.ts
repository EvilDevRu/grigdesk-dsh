import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { decodeDeepSeekHostContract, type DeepSeekHostContract } from '../chat/deepSeekBinary.ts';

/**
 * Снимок host-контракта GrigDesk — единственный источник ревизий GLM-профиля и политики
 * в этом репозитории. Константы ревизий здесь не дублируются: admission identity
 * считается по требованиям потребителя, поэтому сверка всегда идёт с контрактом.
 */
export const DEFAULT_HOST_CONTRACT = fileURLToPath(
  new URL('../../contracts/grigdesk-host-contract.json', import.meta.url),
);

/**
 * Читает и проверяет host-контракт; по умолчанию — снимок из `contracts/`.
 * Явный путь позволяет сверить кандидата с контрактом конкретной установки GrigDesk.
 */
export async function readHostContract(file: string = DEFAULT_HOST_CONTRACT): Promise<DeepSeekHostContract> {
  const text = await readFile(file, 'utf8');

  return decodeDeepSeekHostContract(JSON.parse(text));
}

/**
 * Пара ревизий, которую потребитель требует от поставки.
 */
export function hostGlmRevisions(host: DeepSeekHostContract): { profile: string; policy: string } {
  return { profile: host.glm.profileRevision, policy: host.glm.policyRevision };
}
