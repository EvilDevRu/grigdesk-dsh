import {
  CREDENTIAL_NAMES, credentialsPath, describeCredentials, readCredentials, writeCredentials,
  type CredentialName,
} from './credentials.ts';

export interface LoginIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
}

interface Target {
  name: CredentialName;
  title: string;
  hint: string;
}

const targets: readonly Target[] = [
  { name: 'DEEPSEEK_API_KEY', title: 'DeepSeek API', hint: 'platform.deepseek.com → API keys' },
  { name: 'ZAI_API_KEY', title: 'GLM · Z.ai API', hint: 'z.ai → API Keys (обычный тариф)' },
  { name: 'ZAI_CODING_API_KEY', title: 'GLM · Z.ai Coding Plan', hint: 'z.ai → Coding Plan → API Key' },
  { name: 'QWEN_API_KEY', title: 'Qwen', hint: 'Alibaba Model Studio или QwenCloud Token Plan' },
];

const SOURCE_LABELS: Record<string, string> = {
  env: 'окружение терминала', login: 'deepseek login', grigdesk: '.env GrigDesk',
};

/**
 * `deepseek login` сохраняет ключ в ~/.deepseek/credentials.json (0600) — как
 * `claude login` хранит вход у себя. Ключ не печатается и не попадает в историю
 * оболочки: ввод читается в raw mode посимвольно со звездочками.
 */
export async function runLogin(args: readonly string[], io: LoginIo): Promise<number> {
  const file = credentialsPath(io.env);

  if (args.includes('--status')) {
    return status(io, file);
  }

  if (args[0] === 'logout') {
    return logout(args.slice(1), io, file);
  }

  if (args[0] === 'status') {
    return status(io, file);
  }

  const requested = args[0];
  const target = requested === undefined ? await choose(io) : findTarget(requested);

  if (!target) {
    io.stdout.write(`Неизвестное подключение: ${requested}. `
      + 'Доступны: deepseek, glm api, glm coding-plan, qwen.\n');

    return 2;
  }

  if (!io.stdin.isTTY) {
    throw new Error('Для deepseek login откройте интерактивный терминал.');
  }

  io.stdout.write(`\n${target.title} · ${target.hint}\n`);
  const secret = await readRaw('Вставьте ключ (ввод скрыт) › ', io, true);

  if (secret === null) {
    io.stdout.write('Отменено.\n');

    return 130;
  }

  if (!/^[\x21-\x7e]{8,}$/u.test(secret)) {
    io.stdout.write('Ключ выглядит некорректно: ожидается строка без пробелов длиной от 8 символов.\n');

    return 2;
  }

  const credentials = await readCredentials(file);

  credentials.values[target.name] = secret;
  await writeCredentials(file, credentials);
  io.stdout.write(`Сохранено в ${file} (…${secret.slice(-4)}).\n`);

  return 0;
}

function findTarget(argument: string): Target | undefined {
  const needle = argument.toLowerCase();

  return targets.find((item) => item.name.toLowerCase().includes(needle)
    || item.title.toLowerCase().includes(needle));
}

async function status(io: LoginIo, file: string): Promise<number> {
  const described = await describeCredentials({ env: io.env, file });

  io.stdout.write('\nКлючи терминального чата\n');

  for (const item of targets) {
    const entry = described[item.name];
    const state = entry ? `${entry.preview} · ${SOURCE_LABELS[entry.source] ?? entry.source}` : 'не задан';

    io.stdout.write(`  ${item.title.padEnd(28)} ${state}\n`);
  }

  io.stdout.write(`\nПриоритет: окружение терминала → ${file} → .env GrigDesk.\n`);

  return 0;
}

async function logout(args: readonly string[], io: LoginIo, file: string): Promise<number> {
  const names = args.includes('--all') ? [...CREDENTIAL_NAMES]
    : args.flatMap((argument) => findTarget(argument)?.name ?? []);

  if (names.length === 0) {
    io.stdout.write('Укажите подключение (deepseek, glm, qwen) или --all.\n');

    return 2;
  }

  const credentials = await readCredentials(file);
  let removed = 0;

  for (const name of names) {
    if (credentials.values[name]) {
      delete credentials.values[name];
      removed += 1;
    }
  }

  await writeCredentials(file, credentials);
  io.stdout.write(removed === 0 ? 'В файле не было таких ключей.\n' : `Удалено из ${file}: ${removed}.\n`);

  return 0;
}

async function choose(io: LoginIo): Promise<Target | undefined> {
  if (!io.stdin.isTTY) {
    throw new Error('Для deepseek login откройте интерактивный терминал.');
  }

  io.stdout.write('\nКакое подключение сохранить?\n');

  for (const [index, item] of targets.entries()) {
    io.stdout.write(`  ${index + 1}. ${item.title}\n`);
  }

  const answer = (await readRaw('Номер или Enter для отмены › ', io, false))?.trim() ?? '';

  return /^\d+$/u.test(answer) ? targets[Number(answer) - 1] : undefined;
}

/**
 * Строка читается в raw mode: эхо терминала отключено, поэтому секрет не остаётся
 * на экране и в истории оболочки. Escape-последовательности стрелок отбрасываются.
 */
function readRaw(prompt: string, io: LoginIo, secret: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    let escape = 0;

    io.stdout.write(prompt);
    io.stdin.setRawMode(true);
    io.stdin.resume();

    const finish = (result: string | null) => {
      io.stdin.off('data', onData);
      io.stdin.setRawMode(false);
      io.stdin.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (escape > 0) {
          escape -= 1;

          continue;
        }

        if (char === '\u001b') {
          escape = 2;

          continue;
        }

        if (char === '\r' || char === '\n' || char === '\u0003') {
          io.stdout.write('\n');
          finish(char === '\u0003' ? null : value);

          return;
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          io.stdout.write('\b \b');

          continue;
        }

        if (char >= ' ') {
          value += char;
          io.stdout.write(secret ? '*' : char);
        }
      }
    };

    io.stdin.on('data', onData);
  });
}
