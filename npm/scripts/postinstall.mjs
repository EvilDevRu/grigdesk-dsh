#!/usr/bin/env node
/**
 * postinstall npm-пакета: ставит ELF версии пакета и связывает команды в ~/.local/bin.
 * Отказ сети или контрольной суммы завершает установку кодом 1: пакет без ELF бесполезен,
 * а `deepseek install` повторяет попытку позже без переустановки пакета.
 */
import { install } from '../bin/launcher.mjs';

install({ log: (line) => process.stderr.write(`${line}\n`) }).then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`Установка DeepSeek Harness не завершена: ${error.message}\n`
    + 'Повторите позже командой `deepseek install` (нужна сеть до GitHub Releases).\n');
  process.exitCode = 1;
});
