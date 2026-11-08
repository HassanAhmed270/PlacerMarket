const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const users = require('../src/modules/users.service');
const { passwordHashPool } = require('../src/lib/passwordHashPool');
const db = require('../src/db.service');
const { ValidationError } = require('../src/lib/errors');

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
  let terminal;
  try {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new ValidationError('Additional administrator creation requires an interactive terminal.');
    }
    terminal = readline.createInterface({ input: stdin, output: stdout });
    const initiatorEmail = await terminal.question('Initiating Admin login email: ');
    const name = await terminal.question('New Admin name: ');
    const email = await terminal.question('New Admin email: ');
    const phone = await terminal.question('New Admin phone (international format): ');
    const password = await questionHidden(terminal, 'New Admin password (12–128 characters): ');
    const result = await users.createAdditionalAdmin(
      { initiatorEmail, name, email, phone, password },
      {
        promptTotpCode: async ({ purpose, email: accountEmail, secret }) => {
          if (purpose === 'initiator') {
            return questionHidden(terminal, `Current authenticator code for ${accountEmail}: `);
          }
          stdout.write(`\nAdd this authenticator secret to the new Admin's app once: ${secret}\n`);
          return questionHidden(terminal, 'New Admin authenticator code: ');
        },
      }
    );
    stdout.write(`Additional administrator created: ${result.email}\n`);
  } finally {
    terminal?.close();
    await passwordHashPool.close();
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.statusCode && error.statusCode < 500
      ? error.message
      : 'Additional administrator creation failed. Check server configuration and database availability.');
    process.exitCode = 1;
  });
}

module.exports = { main };
