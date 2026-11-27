#!/usr/bin/env node
// Точка входа npm bin для команды `deepseek`; провайдер задаётся только именем файла.
import { launch } from './launcher.mjs';

launch().then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
