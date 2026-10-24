import {beforeEach,afterEach,expect,test} from "bun:test";
import {generateKeyPairSync} from "node:crypto";
import {reset,get,post,del} from "./harness";
import {one,run,all} from "../src/db";
import {desktopFactory} from "../src/connections/proxmox-ct";
import {connectionProbe} from "../src/servers";
import {proxmoxTransport} from "../src/connections/proxmox";
const originalExec=proxmoxTransport.exec,originalProbe=connectionProbe.info,originalFactory=desktopFactory.create;
const private_key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs1",format:"pem"}).toString();
let commands:string[],serverId:number,ctState:string;
const body=()=>({server_id:serverId,hostname:"deskswarm-ct",template:"local:vztmpl/debian-13-standard.tar.zst",storage:"local-lvm",bridge:"vmbr0",cores:2,memory:2048,disk:16,start_desktop:false});
beforeEach(async()=>{
 reset();commands=[];ctState="running";
 connectionProbe.info=async()=>({hostname:"pve",version:"29",architecture:"amd64",cpus:4,memory_mb:4096,containers:0});
 const config={name:"pve",host:"100.64.1.2",username:"root",port:22,fingerprint:"SHA256:"+"A".repeat(43),private_key,passphrase:""};
 const ticket=(await post("/api/v1/servers/test",{json:config})).json.data.test_token;
 serverId=(await post("/api/v1/servers",{json:{...config,test_token:ticket}})).json.data.id;
 proxmoxTransport.exec=async(c,command)=>{
  commands.push(command);
  if(command==="hostname -s")return "pve\n";
  if(command.includes("/cluster/resources"))return JSON.stringify([{node:"pve",type:"lxc",vmid:110,name:"deskswarm-ct",status:ctState,cpu:0.25,maxcpu:2,mem:512*1048576,maxmem:4*1073741824,disk:2*1073741824,maxdisk:16*1073741824},{node:"other",type:"lxc",vmid:999,name:"other-node",status:"running"}]);
  if(command.includes("/status/current"))return JSON.stringify({status:ctState});
  if(command==="pct shutdown 110 --timeout 60"){ctState="stopped";return "";}
  if(command==="pct start 110"||command==="pct reboot 110 --timeout 60"){ctState="running";return "";}
  if(command.includes("'/nodes'"))return JSON.stringify([{node:"pve",status:"online"}]);
  if(command.includes("'/nodes/pve/storage'"))return JSON.stringify([{storage:"local-lvm",active:1,content:"rootdir,images",avail:100*1073741824},{storage:"local",active:1,content:"vztmpl",avail:100*1073741824}]);
  if(command.includes("'/nodes/pve/network'"))return JSON.stringify([{iface:"vmbr0",type:"bridge",active:1}]);
  if(command.includes("'/nodes/pve/lxc'"))return "[]";
  if(command.includes("'/cluster/nextid'"))return "110";
  if(command.includes("/content'"))return JSON.stringify([{content:"vztmpl",volid:"local:vztmpl/debian-13-standard.tar.zst",size:1000}]);
  if(command.includes("ip -j"))return JSON.stringify([{addr_info:[{scope:"global",local:"192.168.1.50"}]}]);
  if(command.includes("cat /etc/ssh/ssh_host"))return "ssh-ed25519 "+Buffer.from("fixture-host-key").toString("base64");
  return "";
 };
});
afterEach(()=>{proxmoxTransport.exec=originalExec;connectionProbe.info=originalProbe;desktopFactory.create=originalFactory});
async function terminal(){for(let n=0;n<100;n++){const jobs=(await get("/api/v1/connections/proxmox")).json.data.jobs;if(jobs[0]?.status!=="running")return jobs[0];await new Promise(r=>setTimeout(r,5));}throw Error("job did not finish")}
test("Proxmox discovery and writes are authenticated and reject cross-site requests",async()=>{
 expect((await get("/api/v1/connections/proxmox",{noCookie:true})).status).toBe(401);
 expect((await post("/api/v1/connections/proxmox/create",{json:body(),noCookie:true})).status).toBe(401);
 expect((await post("/api/v1/connections/proxmox/create",{json:body(),headers:{origin:"https://attacker.example"}})).status).toBe(403);
 expect(commands).toHaveLength(0);
});
test("discovers cached templates and storage, saves non-secret defaults, and validates shell inputs before provisioning",async()=>{
 const result=await post("/api/v1/connections/proxmox/discover",{json:{server_id:serverId}});
 expect(result.json.data.node).toBe("pve");expect(result.json.data.nextid).toBe(110);
 expect((await post("/api/v1/connections/proxmox/settings",{json:body()})).status).toBe(200);
 expect((await get("/api/v1/connections/proxmox")).text).not.toContain(private_key);
 for(const change of [{hostname:"bad;touch /tmp/pwn"},{disk:0},{template:"../../etc/passwd"},{bridge:"vmbr1"},{storage:"missing"}])expect((await post("/api/v1/connections/proxmox/create",{json:{...body(),...change}})).status).toBe(400);
 expect(commands.some(c=>c.includes("pct create"))).toBe(false);
});
test("provisions an unprivileged CT, pins a host key read through parent SSH, registers Docker once, and keeps credentials off CT",async()=>{
 const created=await post("/api/v1/connections/proxmox/create",{json:body()});expect(created.status).toBe(200);
 const job=await terminal();expect(job.status).toBe("completed");expect(job.result_server_id).toBeGreaterThan(serverId);
 const creation=commands.find(c=>c.includes("pct create"))!;
 expect(creation).toContain("--unprivileged 1");expect(creation).toContain("nesting=1,keyctl=1");expect(creation).not.toContain(private_key);
 expect(commands.some(c=>c.includes("docker run --rm hello-world"))).toBe(true);
 const child=one("SELECT * FROM servers WHERE id=?",job.result_server_id)!;expect(child.host).toBe("192.168.1.50");expect(child.secret).not.toContain(private_key);
 expect(commands.some(c=>c.includes("pct destroy"))).toBe(false);
});
test("failed provisioning retains the CT identity and a safe error without creating a managed server",async()=>{
 const exec=proxmoxTransport.exec;
 proxmoxTransport.exec=async(c,cmd,t)=>{if(cmd.includes("pct exec 110 -- sh"))throw Error("private remote error");return exec(c,cmd,t)};
 await post("/api/v1/connections/proxmox/create",{json:body()});
 const job=await terminal();expect(job.status).toBe("failed");expect(job.vmid).toBe(110);expect(job.error).not.toContain("private remote");expect(job.result_server_id).toBeNull();
 expect(one("SELECT COUNT(*) n FROM servers")!.n).toBe(1);
});
test("concurrent creation and removing an active Proxmox host are rejected",async()=>{
 const exec=proxmoxTransport.exec;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 proxmoxTransport.exec=async(c,cmd,t)=>{if(cmd.includes("pct create"))await gate;return exec(c,cmd,t)};
 await post("/api/v1/connections/proxmox/create",{json:body()});
 expect((await post("/api/v1/connections/proxmox/create",{json:body()})).status).toBe(400);
 expect((await del(`/api/v1/servers/${serverId}`)).status).toBe(409);
 release();expect((await terminal()).status).toBe("completed");
});

const actionPath=()=>"/api/v1/connections/proxmox/cts/110/actions";
const act=(action:string,extra={})=>post(actionPath(),{json:{server_id:serverId,expected_name:"deskswarm-ct",action,...extra}});
async function operationDone(){for(let n=0;n<100;n++){const op=one("SELECT * FROM proxmox_operations ORDER BY rowid DESC LIMIT 1");if(op&&op.status!=="running")return op;await new Promise(r=>setTimeout(r,5));}throw Error("operation did not finish")}
async function provisionChild(){await post("/api/v1/connections/proxmox/create",{json:body()});return terminal()}
test("CT inventory uses live cluster metrics, excludes other nodes, and distinguishes linked Docker computers",async()=>{
 const result=await get(`/api/v1/connections/proxmox/cts?server_id=${serverId}`);
 expect(result.status).toBe(200);expect(result.json.data.containers).toHaveLength(1);
 expect(result.json.data.containers[0].cpu_percent).toBe(25);
 expect(result.json.data.containers[0].memory_total).toBe(4*1073741824);
 expect(result.json.data.containers[0].child_server_id).toBeNull();
 expect((await get(`/api/v1/connections/proxmox/cts?server_id=${serverId}`,{noCookie:true})).status).toBe(401);
 expect((await post(actionPath(),{noCookie:true,json:{}})).status).toBe(401);
 expect((await post(actionPath(),{headers:{origin:"https://attacker.example"},json:{}})).status).toBe(403);
 expect((await act("destroy")).status).toBe(409);
 expect((await act("stop",{expected_name:"changed"})).status).toBe(409);
});
test("graceful stop/start/reboot verify actual CT state and reconnect the same pinned Docker host",async()=>{
 const child=await provisionChild();
 expect((await act("stop")).status).toBe(202);expect((await operationDone()).status).toBe("completed");
 expect(ctState).toBe("stopped");expect(serverByIdForTest(child.result_server_id).status).toBe("stopped");
 expect((await act("start")).status).toBe(202);expect((await operationDone()).status).toBe("completed");
 expect(serverByIdForTest(child.result_server_id).status).toBe("connected");
 expect((await act("restart")).status).toBe(202);expect((await operationDone()).status).toBe("completed");
 expect(commands).toContain("pct shutdown 110 --timeout 60");expect(commands).toContain("pct reboot 110 --timeout 60");
 expect(commands.some(c=>c.includes("forceStop")||c.includes("pct destroy"))).toBe(false);
});
function serverByIdForTest(id:number){return one("SELECT * FROM servers WHERE id=?",id)!}
test("bulk desktop creation uses the linked CT server, unique names, and preserves partial success",async()=>{
 const child=await provisionChild();const names:string[]=[];
 run("INSERT INTO computers(name,slug,novnc_port,vnc_password,image,provider,created_at) VALUES('pc-01','pc-01',16901,'fixture',NULL,?,'')",`server:${child.result_server_id}`);
 desktopFactory.create=async(name,image,provider)=>{names.push(name);expect(provider).toBe(`server:${child.result_server_id}`);if(name==="pc-03")throw Error("private failure");return {id:777,name} as any};
 expect((await act("computers",{count:2,prefix:"pc"})).status).toBe(202);
 const op=await operationDone();expect(op.status).toBe("partial");expect(names).toEqual(["pc-02","pc-03"]);
 expect(JSON.parse(op.result).created[0].id).toBe(777);expect(op.result).not.toContain("private failure");
 expect((await act("computers",{count:11,prefix:"pc"})).status).toBe(409);
 expect((await act("computers",{count:2,prefix:"; bad"})).status).toBe(409);
});
test("CT operations block overlapping actions, server removal, and computer mutations",async()=>{
 const child=await provisionChild();
 run("INSERT INTO computers(name,slug,novnc_port,vnc_password,image,provider,created_at) VALUES('busy','busy',16901,'fixture',NULL,?,'')",`server:${child.result_server_id}`);
 const computer=one("SELECT id FROM computers WHERE name='busy'")!;
 const exec=proxmoxTransport.exec;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 proxmoxTransport.exec=async(c,cmd,t)=>{if(cmd.startsWith("pct shutdown"))await gate;return exec(c,cmd,t)};
 expect((await act("stop")).status).toBe(202);
 expect((await act("restart")).status).toBe(409);
 expect((await del(`/api/v1/servers/${child.result_server_id}`)).status).toBe(409);
 expect((await post(`/api/v1/computers/${computer.id}/exec`,{json:{command:"id"}})).status).toBe(409);
 release();expect((await operationDone()).status).toBe("completed");
});

test("an active Agent prevents CT shutdown without changing the lease or executing pct",async()=>{
 const child=await provisionChild();
 run("INSERT INTO computers(name,slug,novnc_port,vnc_password,image,provider,created_at) VALUES('owned','owned',16901,'fixture',NULL,?,'')",`server:${child.result_server_id}`);
 const computer=one("SELECT id FROM computers WHERE name='owned'")!;
 run("INSERT INTO agent_runs(computer_id,model_id,task,status,lease,max_steps,max_seconds,created_at,updated_at,actor) VALUES(?,1,'fixture','running',1,10,100,'','','test')",computer.id);
 expect((await act("stop")).status).toBe(409);
 expect(one("SELECT lease FROM agent_runs WHERE computer_id=?",computer.id)!.lease).toBe(1);
 expect(commands.some(c=>c.startsWith("pct shutdown"))).toBe(false);
});
