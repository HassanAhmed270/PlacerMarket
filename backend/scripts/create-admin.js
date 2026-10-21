const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const users = require('../src/modules/users.service');
const { generateTotpSecret } = require('../src/lib/totp');
const { passwordHashPool } = require('../src/lib/passwordHashPool');
const db = require('../src/db.service');

async function questionHidden(terminal, prompt) {
  const writer = terminal._writeToOutput.bind(terminal);
  let showPrompt = true;
  terminal._writeToOutput = (value) => { if (showPrompt) writer(value); };
  const answer = terminal.question(prompt);
  showPrompt = false;
  try { return await answer; }
  finally {
    terminal._writeToOutput = writer;
    stdout.write('\n');
  }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Administrator bootstrap requires an interactive terminal.');
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    const name = await terminal.question('Administrator name: ');
    const email = await terminal.question('Administrator email: ');
    const phone = await terminal.question('Administrator phone (international format): ');
    const password = await questionHidden(terminal, 'Initial password (12–128 characters): ');
    const secret = generateTotpSecret();
    const label = encodeURIComponent(`Poshaak:${email.trim().toLowerCase()}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Poshaak&algorithm=SHA1&digits=6&period=30`;
    stdout.write(`\nAdd this authenticator secret to your TOTP app: ${secret}\n`);
    stdout.write(`Authenticator URI: ${uri}\nWait for the next 30-second code before signing in after bootstrap.\n`);
    const code = await questionHidden(terminal, 'Authenticator code: ');
    const result = await users.createInitialAdmin({ name, email, phone, password, totpSecret: secret, totpCode: code });
    stdout.write(`Initial administrator created: ${result.email}\n`);
  } finally {
    terminal.close();
    await passwordHashPool.close();
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.statusCode && error.statusCode < 500 ? error.message : 'Administrator bootstrap failed. Check server configuration and database availability.');
    process.exitCode = 1;
  });
}

module.exports = { main };
