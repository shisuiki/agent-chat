import { execFileSync } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve('.');
const cleanupDirs = new Set();

function trackTempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function setupSandbox() {
  const tmp = trackTempDir('agent-up-resume-');
  const runtimeDir = path.join(tmp, 'runtime');
  const homeDir = path.join(tmp, 'home');
  const fakeBin = path.join(tmp, 'bin');
  const cliRoot = path.join(tmp, 'agent-chat');
  const cliBinDir = path.join(cliRoot, 'bin');
  const cliScriptsDir = path.join(cliRoot, 'scripts');
  const workdir = path.join(tmp, 'workdir');
  const tmuxLog = path.join(tmp, 'tmux.log');
  mkdirSync(path.join(runtimeDir, 'data', 'agents'), { recursive: true });
  mkdirSync(path.join(homeDir, '.codex', 'sessions'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(cliBinDir, { recursive: true });
  mkdirSync(cliScriptsDir, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'bin', 'agentchat'), path.join(cliBinDir, 'agentchat'));
  copyFileSync(path.join(REPO_ROOT, 'bin', 'agent-up'), path.join(cliBinDir, 'agent-up'));
  copyFileSync(path.join(REPO_ROOT, 'bin', 'agent-up-v1'), path.join(cliBinDir, 'agent-up-v1'));
  chmodSync(path.join(cliBinDir, 'agentchat'), 0o755);
  chmodSync(path.join(cliBinDir, 'agent-up'), 0o755);
  chmodSync(path.join(cliBinDir, 'agent-up-v1'), 0o755);
  writeFileSync(path.join(cliScriptsDir, 'provision-v1-agent-home.js'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
let name = '';
let type = 'claude';
let home = path.join(process.env.HOME || process.cwd(), '.agentchat');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--name') name = args[++i] || '';
  else if (args[i] === '--type') type = args[++i] || type;
  else if (args[i] === '--home') home = args[++i] || home;
  else if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) i += 1;
}
if (!name) process.exit(2);
const agentId = 'agent_' + name;
const homeDir = path.join(home, 'agents', agentId);
const stateDir = path.join(homeDir, 'state');
const workdir = path.join(homeDir, 'workdir');
const agentJsonPath = path.join(homeDir, 'agent.json');
mkdirSync(stateDir, { recursive: true });
mkdirSync(workdir, { recursive: true });
writeFileSync(agentJsonPath, JSON.stringify({ name, id: agentId, type, workdir, stateDir }, null, 2));
process.stdout.write(JSON.stringify({
  paths: { homeDir, stateDir, workdir, agentId, agentJsonPath },
  subconsciousEnabled: false,
}));
`);

  writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
method="GET"
out_file=""
write_out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X)
      method="$2"
      shift 2
      ;;
    -o)
      out_file="$2"
      shift 2
      ;;
    -w)
      write_out="$2"
      shift 2
      ;;
    -H|-d|--data|--data-raw|--noproxy)
      shift 2
      ;;
    -s|-S|-sS|--silent|--show-error)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
code=200
body='{"ok":true}'
if [[ "$url" == */api/agents/* ]]; then
  name="\${url##*/api/agents/}"
  name="\${name%%/*}"
  if [ "$method" = "GET" ] && [ "$name" = "taken" ]; then
    code=200
    body='{"name":"taken","type":"codex"}'
  elif [ "$method" = "GET" ]; then
    code=404
    body='{"error":"agent not found"}'
  fi
elif [[ "$url" == */api/agents ]]; then
  code=200
  body='{"ok":true}'
fi
if [ -n "$out_file" ]; then
  printf '%s' "$body" > "$out_file"
else
  printf '%s' "$body"
fi
if [ -n "$write_out" ]; then
  printf '%s' "$code"
fi
`);

  writeExecutable(path.join(fakeBin, 'tmux'), `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  list-sessions)
    exit 0
    ;;
  has-session)
    exit 1
    ;;
  new-session)
    printf 'new-session %s\\n' "$*" >> "$FAKE_TMUX_LOG"
    exit 0
    ;;
  send-keys)
    printf 'send-keys %s\\n' "$*" >> "$FAKE_TMUX_LOG"
    exit 0
    ;;
  capture-pane)
    printf '%% '
    exit 0
    ;;
  display-message)
    case "$*" in
      *pane_current_path*)
        printf '\\n'
        ;;
      *pane_current_command*)
        printf 'bash\\n'
        ;;
      *)
        printf '\\n'
        ;;
    esac
    exit 0
    ;;
  *)
    printf 'tmux %s %s\\n' "$cmd" "$*" >> "$FAKE_TMUX_LOG"
    exit 0
    ;;
esac
`);

  return {
    tmp,
    cliRoot,
    runtimeDir,
    homeDir,
    fakeBin,
    workdir,
    tmuxLog,
    agentchatBin: path.join(cliBinDir, 'agentchat'),
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      AGENT_CHAT_RUNTIME_DIR: runtimeDir,
      AGENT_CHAT_API: 'http://agent-chat.test',
      AGENT_SCOPE_ENABLE: '0',
      HOME: homeDir,
      FAKE_TMUX_LOG: tmuxLog,
    },
  };
}

function runCli(agentchatBin, args, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  delete mergedEnv.AGENTCHAT_LAUNCH_MODEL;
  delete mergedEnv.AGENTCHAT_LAUNCH_EXTRA_ARGS;
  delete mergedEnv.AGENT_SCOPE_MEMORY_HIGH_MB;
  delete mergedEnv.AGENT_SCOPE_MEMORY_MAX_MB;
  delete mergedEnv.AGENT_SCOPE_MEMORY_SWAP_MAX_MB;
  return execFileSync(agentchatBin, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: mergedEnv,
  });
}

function runCliFail(agentchatBin, args, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  delete mergedEnv.AGENTCHAT_LAUNCH_MODEL;
  delete mergedEnv.AGENTCHAT_LAUNCH_EXTRA_ARGS;
  delete mergedEnv.AGENT_SCOPE_MEMORY_HIGH_MB;
  delete mergedEnv.AGENT_SCOPE_MEMORY_MAX_MB;
  delete mergedEnv.AGENT_SCOPE_MEMORY_SWAP_MAX_MB;
  try {
    execFileSync(agentchatBin, args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('expected command to fail');
  } catch (e) {
    return { stdout: e.stdout?.toString() || '', stderr: e.stderr?.toString() || '', status: e.status };
  }
}

function seedCodexSession(homeDir, workdir, sessionId, agentName) {
  const filePath = path.join(homeDir, '.codex', 'sessions', `session-${sessionId}.jsonl`);
  writeFileSync(filePath, [
    JSON.stringify({ payload: { cwd: workdir } }),
    JSON.stringify({ payload: { text: `Your name is ${agentName}.` } }),
    '',
  ].join('\n'));
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('agentchat up --resume-id', () => {
  test('rejects --resume-id combined with --fresh before provisioning or launch', () => {
    const { agentchatBin, env } = setupSandbox();
    const result = runCliFail(agentchatBin, [
      'up',
      'newbie',
      '--resume-id',
      '11111111-2222-3333-4444-555555555555',
      '--fresh',
    ], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resume-id cannot be combined with --fresh');
  });

  test('rejects explicit resume-id when the backend agent table already has the name', () => {
    const { agentchatBin, env } = setupSandbox();
    const result = runCliFail(agentchatBin, [
      'up',
      'taken',
      '--resume-id',
      '11111111-2222-3333-4444-555555555555',
    ], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only allowed when 'taken' is absent from the backend agent table");
  });

  test('first-time codex launch writes explicit resume-id and resumes that session', () => {
    const { agentchatBin, env, runtimeDir, homeDir, workdir, tmuxLog } = setupSandbox();
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    seedCodexSession(homeDir, workdir, sessionId, 'newbie');

    const out = runCli(agentchatBin, [
      'up',
      'newbie',
      workdir,
      'codex',
      '--resume-id',
      sessionId,
    ], env);

    const agentDir = path.join(runtimeDir, 'data', 'agents', 'newbie');
    expect(readFileSync(path.join(agentDir, 'resume-id'), 'utf-8').trim()).toBe(sessionId);
    expect(JSON.parse(readFileSync(path.join(agentDir, 'meta.json'), 'utf-8')).sessionId).toBe(sessionId);
    expect(existsSync(path.join(agentDir, 'tmp', 'launch-codex.sh'))).toBe(true);
    expect(readFileSync(path.join(agentDir, 'tmp', 'launch-codex.sh'), 'utf-8')).toContain(`exec codex resume ${sessionId}`);
    expect(readFileSync(tmuxLog, 'utf-8')).toContain('launch-codex.sh');
    expect(out).toContain(`Resuming codex session: ${sessionId}`);
  });

  test('up-v1 rejects --resume-id with --fresh before provisioning', () => {
    const { agentchatBin, env, homeDir } = setupSandbox();
    const result = runCliFail(agentchatBin, [
      'up-v1',
      'v1new',
      'codex',
      '--resume-id',
      '11111111-2222-3333-4444-555555555555',
      '--fresh',
      '--home',
      path.join(homeDir, 'agentchat-home'),
    ], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resume-id cannot be combined with --fresh');
    expect(existsSync(path.join(homeDir, 'agentchat-home', 'agents', 'agent_v1new'))).toBe(false);
  });

  test('up-v1 passes explicit resume-id through the v1 state symlink', () => {
    const { agentchatBin, env, runtimeDir, homeDir } = setupSandbox();
    const v1HomeRoot = path.join(homeDir, 'agentchat-home');
    const v1Workdir = path.join(v1HomeRoot, 'agents', 'agent_v1new', 'workdir');
    const v1StateDir = path.join(v1HomeRoot, 'agents', 'agent_v1new', 'state');
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    seedCodexSession(homeDir, v1Workdir, sessionId, 'v1new');

    const out = runCli(agentchatBin, [
      'up-v1',
      'v1new',
      'codex',
      '--resume-id',
      sessionId,
      '--home',
      v1HomeRoot,
    ], env);

    const compatDir = path.join(runtimeDir, 'data', 'agents', 'v1new');
    expect(readFileSync(path.join(v1StateDir, 'resume-id'), 'utf-8').trim()).toBe(sessionId);
    expect(readFileSync(path.join(compatDir, 'resume-id'), 'utf-8').trim()).toBe(sessionId);
    expect(JSON.parse(readFileSync(path.join(compatDir, 'meta.json'), 'utf-8')).sessionId).toBe(sessionId);
    expect(readFileSync(path.join(compatDir, 'tmp', 'launch-codex.sh'), 'utf-8')).toContain(`exec codex resume ${sessionId}`);
    expect(out).toContain('Provisioned v1 agent home:');
    expect(out).toContain(`Resuming codex session: ${sessionId}`);
  });
});
