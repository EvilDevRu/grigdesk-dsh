/**
 * Единое имя исполняемого файла для рабочего каталога, payload и выпуска.
 * Метаданные сохраняют имя платформы Node, в том числе win32.
 */
export function executableName(stem: string, platform: string = process.platform): string {
  return platform === 'win32' ? `${stem}.exe` : stem;
}

/**
 * Публичное имя настольного артефакта совпадает в manifest и ссылках на релиз.
 * Внутреннее имя исполняемого файла сохраняет контракт команды deepseek.
 */
export function releaseAssetName(platform: string, arch: string): string {
  return executableName(`dsh-${platform}-${arch}`, platform);
}
