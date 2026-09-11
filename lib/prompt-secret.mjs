/**
 * Credential input for the operator scripts.
 *
 * Order of preference:
 *   1. The environment variable, if already set — CI, and anyone who prefers to
 *      export once per shell.
 *   2. An interactive prompt, with secret values masked as you type.
 *   3. A clear failure when neither is possible (piped/non-TTY).
 *
 * Why prompting is the better default for hand-run scripts: an exported secret
 * lands in shell history, in the environment of every child process, and in
 * whatever crash reporter happens to dump env. A prompt keeps it in this
 * process and nowhere else. The value is never echoed, never logged, and never
 * written to disk by these scripts.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

function ask(question, { mask }) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('not a TTY — cannot prompt'));
      return;
    }

    let hide = false;
    // The question itself must reach the terminal; everything typed after it
    // must not. Flipping `hide` after rl.question() writes the prompt is what
    // separates the two.
    const out = new Writable({
      write(chunk, enc, cb) {
        if (!hide) process.stdout.write(chunk, enc);
        cb();
      },
    });

    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write('\n');
      resolve(answer.trim());
    });
    hide = mask;
  });
}

/**
 * Resolve one credential. `secret: true` masks the typed value.
 * Exits with a usable message rather than a stack trace when it cannot.
 */
export async function requireEnv(name, { secret = true, label } = {}) {
  const existing = process.env[name];
  if (existing) return existing;

  const prompt = `  ${label || name}${secret ? ' (hidden)' : ''}: `;
  try {
    const value = await ask(prompt, { mask: secret });
    if (!value) {
      console.error(`\n✗ ${name} is required.`);
      process.exit(1);
    }
    return value;
  } catch {
    console.error(
      `\n✗ ${name} is not set and this shell cannot prompt.` +
      `\n  Set it for one command instead:  $env:${name}="…"; node <script>`
    );
    process.exit(1);
  }
}

/** Small banner so it is obvious why a script is suddenly asking for input. */
export function credentialNotice(what) {
  if (process.stdin.isTTY) {
    console.log(`\n  ${what} — values are not echoed and are not saved.\n`);
  }
}
