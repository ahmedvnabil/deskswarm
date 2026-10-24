/** Keep the shell's process group attached even when setsid must fork. */
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function agentShellCommand(id: number, command: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw Error("Invalid agent run ID");
  const inner = `echo $$ > /tmp/deskswarm-agent-${id}.pid; exec timeout --kill-after=2s 60s bash -lc ${quote(command)}`;
  // Docker exec can start us as a process-group leader. Without --wait, setsid
  // forks and reports success before the desktop command actually finishes.
  return `DESKSWARM_AGENT_RUN_ID=${id} setsid --wait bash -c ${quote(inner)}`;
}
