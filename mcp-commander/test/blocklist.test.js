// Table-driven check of the command blocklist guard rail (default blockedCommands list).
// Desktop Commander only compared the first word of each ;/&&/||/|/& segment, so every row in
// MUST_BLOCK except the plainest ones passed straight through it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers.js';

const { checkCommand, extractCommands } = await load('security/commands.js');
const { DEFAULT_BLOCKED_COMMANDS } = await load('config.js');

const MUST_BLOCK = [
  ['sudo ls', 'sudo'],
  ['/usr/bin/sudo ls', 'sudo'],
  ['SUDO ls', 'sudo'],
  ['\\sudo ls', 'sudo'],
  ["s''udo ls", 'sudo'],
  ['s"u"do ls', 'sudo'],
  [' sudo ls', 'sudo'],
  ['sudo', 'sudo'],
  ['sudo.exe ls', 'sudo'],
  ['bash -c "sudo reboot"', 'sudo'],
  ["sh -c 'dd if=/dev/zero of=x'", 'dd'],
  ['zsh -lc "sudo x"', 'sudo'],
  ['echo hi\nsudo ls', 'sudo'],
  ['ls\r\nsudo ls', 'sudo'],
  ['ls; \nreboot', 'reboot'],
  ['echo hi; sudo ls', 'sudo'],
  ['true && sudo ls', 'sudo'],
  ['false || sudo ls', 'sudo'],
  ['ls | sudo tee x', 'sudo'],
  ['ls & sudo ls', 'sudo'],
  ['echo $(sudo id)', 'sudo'],
  ['echo `sudo id`', 'sudo'],
  ['echo "$(sudo id)"', 'sudo'],
  ['a=$(sudo ls)', 'sudo'],
  ['cat <(sudo ls)', 'sudo'],
  ['(sudo ls)', 'sudo'],
  ['{ sudo ls; }', 'sudo'],
  ['FOO=1 sudo ls', 'sudo'],
  ['FOO="a b" sudo ls', 'sudo'],
  ['env sudo ls', 'sudo'],
  ['env -i PATH=/bin sudo ls', 'sudo'],
  ['command sudo ls', 'sudo'],
  ['exec sudo ls', 'sudo'],
  ['nice -n 10 sudo ls', 'sudo'],
  ['nohup sudo ls', 'sudo'],
  ['time sudo ls', 'sudo'],
  ['timeout 5 sudo ls', 'sudo'],
  ['xargs sudo', 'sudo'],
  ['xargs -I{} sudo rm {}', 'sudo'],
  ['eval "sudo ls"', 'sudo'],
  ['eval sudo ls', 'sudo'],
  ['if true; then sudo ls; fi', 'sudo'],
  ['for i in 1; do sudo ls; done', 'sudo'],
  ['while true; do reboot; done', 'reboot'],
  ['mkfs.ext4 /dev/sda1', 'mkfs'],
  ['shutdown -h now', 'shutdown'],
];

const MUST_ALLOW = [
  'ls -la',
  'echo sudo',
  'grep sudo /etc/group',
  'git commit -m "fix sudo docs"',
  'npm run build && npm test',
  'python3 -c "print(1)"',
  'ls 2>&1 | head',
  'cat file > out.txt',
  'echo "a;b|c&d"',
  'find . -name "*.ts" -exec wc -l {} \\;',
  'docker ps',
  'initdb -D x',
  './init.sh',
  'bash init.sh',
  'formatter --check',
  'netstat -an',
  'scp a b',
  'ddate',
  'for f in *.txt; do wc -l "$f"; done',
];

test('blocklist: every bypass form of a blocked command is caught', () => {
  const misses = [];
  for (const [cmd, name] of MUST_BLOCK) {
    const r = checkCommand(cmd, DEFAULT_BLOCKED_COMMANDS);
    if (r.allowed || r.blocked !== name) misses.push(`${JSON.stringify(cmd)} -> ${JSON.stringify(r)} (commands: ${extractCommands(cmd)})`);
  }
  assert.deepEqual(misses, []);
});

test('blocklist: ordinary commands that merely mention a blocked word stay allowed', () => {
  const falsePositives = [];
  for (const cmd of MUST_ALLOW) {
    const r = checkCommand(cmd, DEFAULT_BLOCKED_COMMANDS);
    if (!r.allowed) falsePositives.push(`${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
  }
  assert.deepEqual(falsePositives, []);
});

test('blocklist: user-supplied entries are matched case-insensitively and an empty list allows all', () => {
  assert.equal(checkCommand('Terraform destroy', ['terraform']).allowed, false);
  assert.equal(checkCommand('terraform plan', [' TERRAFORM ']).allowed, false);
  assert.equal(checkCommand('sudo ls', []).allowed, true);
});
