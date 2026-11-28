/**
 * Единое имя исполняемого файла для рабочего каталога, payload и выпуска.
 * Метаданные сохраняют имя платформы Node, в том числе win32.
 */
export function executableName(stem: string, platform: string = process.platform): string {
  return platform === 'win32' ? `${stem}.exe` : stem;
}
