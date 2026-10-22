const TERMINALS = ['warp', 'cmux', 'iterm']
const CMUX_BUNDLED = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const ITERM_NEW_TAB = `on run argv
  tell application "iTerm"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window to write text (item 1 of argv)
  end tell
end run`

export function quote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export function forkCommand(sessionId, prompt) {
  const command = `claude --resume ${quote(sessionId)} --fork-session`
  return prompt.trim() ? `${command} ${quote(prompt.trim())}` : command
}

export function warpTabConfig(cwd, command) {
  return [
    'name = "Claude fork"',
    '',
    '[[panes]]',
    'id = "fork"',
    'type = "terminal"',
    `directory = ${JSON.stringify(cwd)}`,
    `commands = [${JSON.stringify(command)}]`,
    '',
  ].join('\n')
}

export function terminalOrder(cmuxWorkspace, termProgram) {
  const host = cmuxWorkspace ? 'cmux' : { WarpTerminal: 'warp', 'iTerm.app': 'iterm' }[termProgram]
  return host ? [host, ...TERMINALS.filter((t) => t !== host)] : TERMINALS
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'fork-new-tab',
        description: 'Fork this session into a new terminal tab (Warp, cmux or iTerm)',
        argumentHint: '[prompt]',
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'fork-new-tab' }, async ($, e) => {
    const command = forkCommand(await $.session.id(), e.args ?? '')
    const cwd = await $.session.cwd()
    const succeeds = async (argv) => {
      try {
        return (await $.process.run(argv)).exitCode === 0
      } catch {
        return false
      }
    }
    const openers = {
      async warp() {
        if (!(await succeeds(['open', '-Ra', 'Warp']))) return false
        await $.fs.write(`${await $.env.get('HOME')}/.warp/tab_configs/claude-fork.toml`, warpTabConfig(cwd, command))
        return succeeds(['open', 'warp://tab_config/claude-fork'])
      },
      async cmux() {
        const args = ['new-surface', '--working-directory', cwd, '--command', command, '--focus', 'true']
        return (await succeeds(['cmux', ...args])) || succeeds([CMUX_BUNDLED, ...args])
      },
      async iterm() {
        if (!(await succeeds(['open', '-Ra', 'iTerm']))) return false
        return succeeds(['osascript', '-e', ITERM_NEW_TAB, `cd ${quote(cwd)} && ${command}`])
      },
    }
    for (const terminal of terminalOrder(await $.env.get('CMUX_WORKSPACE_ID'), await $.env.get('TERM_PROGRAM'))) {
      try {
        if (await openers[terminal]()) return {}
      } catch {}
    }
    $.ui.toast(`Could not open a terminal tab. Run: ${command}`)
    return {}
  })
}
