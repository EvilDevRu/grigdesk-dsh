/**
 * Единый launcher трёх команд. Провайдер задаёт файл входа: glm и qwen открывают чат
 * своего провайдера, deepseek оставляет аргументы ELF без изменений. Служебные флаги
 * ELF (--version, --runtime-info, --verify, --help) всегда идут напрямую.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  commandDirectory, dataHome, readCurrentElf, recordedDataHome, recordDataHome,
} from '../scripts/lib/layout.mjs';
import { installVersion, linkCommands } from '../scripts/lib/install.mjs';
import { describePlatform } from '../scripts/lib/platform.mjs';

const ELF_FLAGS = new Set(['-V', '--version', '--runtime-info', '--verify', '--license', '--help', '--json']);
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };
export const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `install` работает и без ELF: докачивает версию пакета после npm --ignore-scripts
 * или неудачной сети. Остальное — запуск действующего ELF с наследованием терминала.
 */
export async function launch(provider) {
  const args = process.argv.slice(2);

  if (args[0] === 'install') {
    return await install({ log: (line) => process.stderr.write(`${line}\n`) });
  }

  const elf = await readCurrentElf(await resolveHome());

  if (!elf) {
    process.stderr.write('DeepSeek Harness не установлен. Выполните:\n'
      + `  ${provider ?? 'deepseek'} install\n`);

    return 1;
  }

  return await run(elf, provider ? forward(provider, args) : args);
}

/**
 * Ставит версию этого пакета и связывает команды. Тег берётся из package.json:
 * npm-пакет и релиз ELF выходят под одной версией.
 * @param {{ log?: (line: string) => void, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [options]
 */
export async function install({ log = () => {}, env = process.env, fetchImpl = fetch } = {}) {
  const platform = describePlatform();

  if (!platform.supported) {
    throw new Error(platform.reason);
  }

  const { version } = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) || version.startsWith('0.0.0')) {
    throw new Error(`Версия пакета ${version} не опубликована: установите @grigdesk/deepseek из npm`);
  }

  // Явное окружение важнее записанного при установке пути, тот — важнее умолчания:
  // повторный install и запуск находят одни и те же версии без повторения переменных.
  const home = await resolveHome(env);
  const installEnv = { ...env, GRIGDESK_DEEPSEEK_DATA_HOME: home };
  const binary = await installVersion({ tag: `v${version}`, platform, env: installEnv, log, fetchImpl });

  await recordDataHome(packageDirectory, home);

  const directory = commandDirectory(env);
  const linked = await linkCommands({ packageDirectory, env, log }).then(() => true, (error) => {
    log(`Команды не созданы: ${error.message}`);

    return false;
  });

  if (linked && !(env.PATH ?? '').split(path.delimiter).includes(directory)) {
    log(`Добавьте ${directory} в PATH или откройте новый терминал`);
  }

  log(`deepseek ${version}: ${binary}`);

  return 0;
}

const ACCOUNT_COMMANDS = new Set(['login', 'logout']);

/**
 * glm/qwen без аргументов открывают чат; с флагами чата — добавляют провайдера;
 * `glm login` сохраняет ключ GLM. Служебные флаги ELF и явный chat -p не переиначиваем.
 */
export function forward(provider, args) {
  if (args.length === 0 || ELF_FLAGS.has(args[0]) || args[0] === '--') {
    return args.length === 0 ? ['chat', '-p', provider] : args;
  }

  if (ACCOUNT_COMMANDS.has(args[0])) {
    return args.length > 1 ? args : [args[0], provider];
  }

  if (args[0] === 'chat') {
    return args.some((arg) => arg === '-p' || arg.startsWith('--provider'))
      ? args : ['chat', '-p', provider, ...args.slice(1)];
  }

  return ['chat', '-p', provider, ...args];
}

async function resolveHome(env = process.env) {
  return env.GRIGDESK_DEEPSEEK_DATA_HOME ?? await recordedDataHome(packageDirectory) ?? dataHome(env);
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });

    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 128 + (SIGNALS[signal] ?? 0) : code ?? 1));
  });
}
