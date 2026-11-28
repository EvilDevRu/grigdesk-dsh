/**
 * Платформа npm-пакета должна совпадать с одним из ELF релиза. Имена сборок
 * совпадают с assets manifest.json: dsh-<platform>-<arch>.
 */
const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64']);

/**
 * Ключ платформы или null там, где поставка не собирается; причина — для сообщения.
 */
export function describePlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;

  return {
    key,
    supported: supported.has(key),
    asset: `dsh-${key}`,
    reason: platform === 'win32'
      ? 'Windows не поддерживается: поставка собирается для Linux x64/arm64 и macOS Apple Silicon'
      : `Нет сборки для ${key}: доступны ${[...supported].sort().join(', ')}`,
  };
}
