#!/usr/bin/env node
// Точка входа npm bin для команды `qwen`; провайдер задаётся только именем файла.
import { launch } from './launcher.mjs';

launch('qwen').then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
