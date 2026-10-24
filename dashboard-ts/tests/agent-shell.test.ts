import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShellCommand } from "../src/agents/shell";

// Force setsid's fork path, as happens with real Docker exec sessions.
test.skipIf(process.platform !== "linux")("agent shell remains attached and its recorded group can be interrupted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-shell-"));
  const id = 900000 + process.pid;
  const pidFile = `/tmp/deskswarm-agent-${id}.pid`;
  let processDone = false;
  const child = Bun.spawn(["setsid", "bash", "-c", `exec env ${agentShellCommand(id, `printf started > ${dir}/started; while [ ! -f ${dir}/release ]; do sleep 0.02; done; printf finished > ${dir}/finished`)}`], {stdout:"pipe",stderr:"pipe"});
  const exited = child.exited.then(code => {processDone = true; return code;});
  try {
    for (let i=0;i<100 && !existsSync(join(dir,"started"));i++) await Bun.sleep(10);
    expect(existsSync(join(dir,"started"))).toBe(true);
    await Bun.sleep(50);
    expect(processDone).toBe(false);
    const group = Number(readFileSync(pidFile,"utf8").trim());
    expect(group).toBeGreaterThan(1);
    const environment = readFileSync(`/proc/${group}/environ`,"utf8").split("\0");
    expect(environment).toContain(`DESKSWARM_AGENT_RUN_ID=${id}`);
    process.kill(-group,"SIGTERM");
    await Promise.race([exited, Bun.sleep(3000).then(()=>{throw Error("shell did not drain")})]);
    expect(existsSync(join(dir,"finished"))).toBe(false);
  } finally {
    writeFileSync(join(dir,"release"),"");
    child.kill();
    await exited;
    rmSync(dir,{recursive:true,force:true});
    rmSync(pidFile,{force:true});
  }
});
