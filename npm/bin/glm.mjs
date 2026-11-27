#!/usr/bin/env node
// Точка входа npm bin для команды `glm`; провайдер задаётся только именем файла.
import { launch } from './launcher.mjs';

launch('glm').then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
