import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const tmp = trackTempDir('agent-register-tmux-');
  const runtimeDir = path.join(tmp, 'runtime');
  const fakeBin = path.join(tmp, 'bin');
  const workdir = path.join(tmp, 'workdir');
  const curlBody = path.join(tmp, 'curl-body.json');
  const curlUrl = path.join(tmp, 'curl-url.txt');

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  writeFileSync(path.join(runtimeDir, '.env'), [
    'AGENT_CHAT_API=http://agent-chat.test',
    'AGENT_CHAT_SERVER=test-server',
    'API_TOKEN=test-token',
    '',
  ].join('\n'));

  writeExecutable(path.join(fakeBin, 'tmux'), `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  has-session)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t)
          target="\${2:-}"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    [ "$target" = "=external" ]
    exit $?
    ;;
  display-message)
    case "$*" in
      *pane_current_path*)
        printf '%s\\n' "$FAKE_TMUX_PANE_PATH"
        ;;
      *)
        printf '\\n'
        ;;
    esac
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

  writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
data=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d|--data|--data-raw)
      data="\${2:-}"
      shift 2
      ;;
    -X|-H|--noproxy)
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
printf '%s' "$data" > "$FAKE_CURL_BODY"
printf '%s' "$url" > "$FAKE_CURL_URL"
if [ "\${FAKE_CURL_ERROR:-0}" = "1" ]; then
  printf '{"error":"backend unavailable"}'
else
  printf '{"ok":true,"agent":%s}' "$data"
fi
`);

  return {
    runtimeDir,
    fakeBin,
    workdir,
    curlBody,
    curlUrl,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AGENT_CHAT_RUNTIME_DIR: runtimeDir,
      FAKE_CURL_BODY: curlBody,
      FAKE_CURL_URL: curlUrl,
      FAKE_TMUX_PANE_PATH: workdir,
    },
  };
}

function runCli(args, env) {
  return execFileSync(path.join(REPO_ROOT, 'bin', 'agentchat'), args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
}

function runCliFail(args, env) {
  try {
    execFileSync(path.join(REPO_ROOT, 'bin', 'agentchat'), args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('expected command to fail');
  } catch (error) {
    return {
      stdout: error.stdout?.toString() || '',
      stderr: error.stderr?.toString() || '',
      status: error.status,
    };
  }
}

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe('agentchat register-tmux', () => {
  test('registers an existing tmux session without launching or writing MCP config', () => {
    const context = setupSandbox();

    const out = runCli(['register-tmux', 'external', context.workdir, 'claude'], context.env);

    expect(out).toContain("Registered tmux session 'external'");
    expect(readFileSync(context.curlUrl, 'utf-8')).toBe('http://agent-chat.test/api/agents');
    const payload = JSON.parse(readFileSync(context.curlBody, 'utf-8'));
    expect(payload).toMatchObject({
      name: 'external',
      type: 'claude',
      tmux: 'external:0.0',
      manualDown: false,
      workdir: context.workdir,
      server: 'test-server',
    });

    const metaPath = path.join(context.runtimeDir, 'data', 'agents', 'external', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(meta).toMatchObject({
      name: 'external',
      path: context.workdir,
      type: 'claude',
      managedLaunch: false,
      registeredFrom: 'tmux',
    });
    expect(existsSync(path.join(context.workdir, '.mcp.json'))).toBe(false);
  });

  test('infers path from tmux pane when omitted', () => {
    const context = setupSandbox();

    runCli(['register-tmux', 'external'], context.env);

    const payload = JSON.parse(readFileSync(context.curlBody, 'utf-8'));
    const metaPath = path.join(context.runtimeDir, 'data', 'agents', 'external', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(payload.workdir).toBe(context.workdir);
    expect(payload.type).toBe('agent');
    expect(meta.path).toBe(context.workdir);
    expect(meta.type).toBe('agent');
  });

  test('fails clearly when the tmux session does not exist', () => {
    const context = setupSandbox();

    const result = runCliFail(['register-tmux', 'missing', context.workdir], context.env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tmux session 'missing' does not exist");
    expect(existsSync(context.curlBody)).toBe(false);
    expect(existsSync(path.join(context.runtimeDir, 'data', 'agents', 'missing', 'meta.json'))).toBe(false);
  });

  test('does not persist local metadata when backend registration fails', () => {
    const context = setupSandbox();

    const result = runCliFail(['register-tmux', 'external', context.workdir], {
      ...context.env,
      FAKE_CURL_ERROR: '1',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backend registration failed');
    expect(existsSync(path.join(context.runtimeDir, 'data', 'agents', 'external', 'meta.json'))).toBe(false);
  });
});
