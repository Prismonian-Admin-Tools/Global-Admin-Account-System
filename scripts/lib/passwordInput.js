'use strict';
const readline = require('readline');

/**
 * Reads a password from the terminal with input masked, instead of
 * requiring it on the command line — a --password flag lands in shell
 * history and is visible to any other user on the box via `ps aux` for
 * as long as the process runs. Falls back to a plain (unmasked) line read
 * when stdin isn't a TTY (piped input, CI), since there's no terminal to
 * control echo on there anyway.
 */
function promptPassword(promptText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.question(promptText, (answer) => { rl.close(); resolve(answer); });
      return;
    }

    process.stdout.write(promptText);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');

    let input = '';
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '': // Ctrl+D
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '': // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          break;
        case '': // backspace
        case '\b':
          input = input.slice(0, -1);
          break;
        default:
          input += char;
      }
    };
    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    }
    process.stdin.on('data', onData);
  });
}

module.exports = { promptPassword };
