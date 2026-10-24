import {beforeEach,afterEach,expect,test} from "bun:test";
import {generateKeyPairSync} from "node:crypto";
import {reset,get,post,del} from "./harness";
import {one} from "../src/db";
import {connectionProbe} from "../src/servers";
import {proxmoxTransport} from "../src/connections/proxmox";
const originalExec=proxmoxTransport.exec,originalProbe=connectionProbe.info;
const private_key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs1",format:"pem"}).toString();
let commands:string[],serverId:number;
const body=()=>({server_id:serverId,hostname:"deskswarm-ct",template:"local:vztmpl/debian-13-standard.tar.zst",storage:"local-lvm",bridge:"vmbr0",cores:2,memory:2048,disk:16,start_desktop:false});
beforeEach(async()=>{
 reset();commands=[];
 connectionProbe.info=async()=>({hostname:"pve",version:"29",architecture:"amd64",cpus:4,memory_mb:4096,containers:0});
 const config={name:"pve",host:"100.64.1.2",username:"root",port:22,fingerprint:"SHA256:"+"A".repeat(43),private_key,passphrase:""};
 const ticket=(await post("/api/v1/servers/test",{json:config})).json.data.test_token;
 serverId=(await post("/api/v1/servers",{json:{...config,test_token:ticket}})).json.data.id;
 proxmoxTransport.exec=async(c,command)=>{
  commands.push(command);
  if(command==="hostname -s")return "pve\n";
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
afterEach(()=>{proxmoxTransport.exec=originalExec;connectionProbe.info=originalProbe});
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
